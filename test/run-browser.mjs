import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import assert from "node:assert/strict";

const testSource = await readFile(new URL("browser.playwright.js", import.meta.url), "utf8");
const verify = runInThisContext(`(${testSource})`);
const artifact = fileURLToPath(new URL("../example/bundled.html", import.meta.url));
const target = process.argv[2] || pathToFileURL(artifact).href;
const browser = await chromium.launch({channel: process.env.BROWSER_CHANNEL || "chrome", headless: true});
try {
  for (const storageDenied of [false, true]) {
    const context = await browser.newContext();
    if (storageDenied) await context.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {get() { throw new DOMException("Storage denied", "SecurityError"); }});
    });
    const page = await context.newPage();
    const requests = [];
    page.on("request", request => requests.push(request.url()));
    const result = await verify(page, target);
    if (target.startsWith("file:")) assert.deepEqual(requests.filter(url => /^https?:/.test(url)), [], "The standalone fixture made a direct HTTP request");
    console.log(JSON.stringify({storageDenied, ...result}));
    await context.close();
  }
} finally { await browser.close(); }
