import { chromium } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";

// Opt-in diagnostic, separate from deterministic CI. Start example/server.mjs first.
const sites = process.argv.slice(2);
if (!sites.length) sites.push("https://example.com/", "https://docs.python.org/3/", "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules");
const artifact = pathToFileURL(fileURLToPath(new URL("../example/bundled.html", import.meta.url))).href;
const output = new URL("../.temp/live-sites/", import.meta.url);
await mkdir(output, {recursive: true});
const channel = process.env.BROWSER_CHANNEL || 'chrome';
const browser = await chromium.launch({channel: channel === 'headless' ? undefined : channel, headless: true});
const report = [];

async function timed(operation, timeout = 45000) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Navigation timed out")), timeout); })]); }
  finally { clearTimeout(timer); }
}

try {
  for (const url of sites) {
    const context = await browser.newContext({viewport: {width: 1280, height: 900}});
    const page = await context.newPage();
    const errors = [];
    const direct = [];
    page.on("pageerror", error => { if (errors.length < 15) errors.push(error.message); });
    page.on("console", message => { if (message.type() === "error" && errors.length < 15) errors.push(message.text().slice(0, 500)); });
    page.on("request", request => { if (/^https?:/.test(request.url())) direct.push(request.url()); });
    const result = {url, errors, direct};
    try {
      await page.goto(artifact);
      await page.waitForFunction(() => globalThis.main_frame && !main_frame.is_navigating);
      await page.evaluate(relay => {
        sandstone.network.set_websocket(relay);
        main_frame.on_load = () => {};
      }, process.env.WISP_URL || "ws://127.0.0.1:5001/");
      const started = Date.now();
      // A script redirect can destroy the first document while its HTML RPC is
      // still pending. Follow the host's current navigation, not that old reply.
      const previous = await page.evaluate(() => main_frame.navigation_id);
      await page.evaluate(url => {main_frame.navigate_to(url).catch(console.error);}, url);
      await page.waitForFunction(previous => main_frame.navigation_id > previous && !main_frame.is_navigating, previous, {timeout:45000});
      // Let startup animations and dynamically inserted resources settle before capture.
      await new Promise(resolve => setTimeout(resolve, Number(process.env.LIVE_SETTLE_MS || 1500)));
      result.elapsed = Date.now() - started;
      result.document = JSON.parse(await timed(page.evaluate(() => main_frame.eval_js(`JSON.stringify({
        title: document.title, url: location.href, readyState: document.readyState,
        text: document.body.innerText.slice(0, 800), images: document.images.length,
        loadedImages: Array.from(document.images).filter(image => image.complete && image.naturalWidth > 0).length,
        scripts: document.scripts.length, error: document.getElementById('error_msg')?.innerText,
        headings: Array.from(document.querySelectorAll('h1,h2')).slice(0, 5).map(element => ({
          text: element.textContent.trim().slice(0, 80), opacity: getComputedStyle(element).opacity,
          visibility: getComputedStyle(element).visibility
        }))
      })`)), 5000));
      await page.screenshot({path: fileURLToPath(new URL(encodeURIComponent(new URL(url).hostname) + ".png", output))});
    } catch (error) {
      result.failure = error.message;
      result.navigation = await page.evaluate(() => ({url:globalThis.main_frame?.url?.href,loading:globalThis.main_frame?.is_navigating})).catch(() => null);
    }
    finally { await context.close(); }
    report.push(result);
    console.log(JSON.stringify(result));
    await writeFile(new URL("report.json", output), JSON.stringify({testedAt: new Date().toISOString(), sites: report}, null, 2));
  }
} finally { await browser.close(); }
