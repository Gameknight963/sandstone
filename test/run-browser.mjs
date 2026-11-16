import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import assert from "node:assert/strict";

const testSource = await readFile(new URL("browser.playwright.js", import.meta.url), "utf8");
const dexieSource = await readFile(new URL("../node_modules/dexie/dist/dexie.js", import.meta.url), "utf8");
const verify = runInThisContext(`(${testSource})`);
const moduleTest = await readFile(new URL("modules.playwright.js", import.meta.url), "utf8");
const verifyModules = runInThisContext(`(${moduleTest})`);
const resourceTest = await readFile(new URL("resources.playwright.js", import.meta.url), "utf8");
const verifyResources = runInThisContext(`(${resourceTest})`);
const workerTest = await readFile(new URL("workers.playwright.js", import.meta.url), "utf8");
const verifyWorkers = runInThisContext(`(${workerTest})`);
const artifact = fileURLToPath(new URL("../example/bundled.html", import.meta.url));
const target = process.argv[2] || pathToFileURL(artifact).href;
async function timed(operation, label) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + " timed out")), 30000); })]); }
  finally { clearTimeout(timer); }
}
const browser = await chromium.launch({channel: process.env.BROWSER_CHANNEL || "chrome", headless: true});
try {
  for (const storageDenied of [false, true]) {
    const context = await browser.newContext();
    if (storageDenied) await context.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {get() { throw new DOMException("Storage denied", "SecurityError"); }});
      Object.defineProperty(window, "indexedDB", {get() { throw new DOMException("Storage denied", "SecurityError"); }});
    });
    const page = await context.newPage();
    const browserErrors = [];
    page.on("pageerror", error => { browserErrors.push(error.message); console.error("Browser error:", error.message); });
    page.on("console", message => {
      if (message.type() === "error") { browserErrors.push(message.text()); console.error("Browser console:", message.text()); }
    });
    const requests = [];
    page.on("request", request => requests.push(request.url()));
    const result = await timed(verify(page, target), "Browser compatibility fixture");
    const moduleResults = await timed(verifyModules(page), "Module fixture");
    result.passed.push(...moduleResults);
    result.passed.push(...await timed(verifyResources(page), "Resource fixture"));
    result.passed.push(...await timed(verifyWorkers(page), "Worker fixture"));
    await page.evaluate(source => main_frame.eval_js(source), dexieSource);
    const dexieResult = await page.evaluate(() => main_frame.eval_js(`(async () => {
      const database = new Dexie('browser-dexie');
      database.version(1).stores({items: '++id,&name'});
      await database.open();
      await database.items.bulkPut([{id: 1, name: 'alpha'}, {id: 2, name: 'beta'}]);
      const values = await database.items.orderBy('name').toArray();
      database.close();
      return JSON.stringify(values.map(value => value.name));
    })()`));
    assert.deepEqual(JSON.parse(dexieResult), ['alpha', 'beta']);
    await page.reload();
    await page.waitForFunction(() => globalThis.main_frame && !main_frame.is_navigating);
    await page.evaluate(async () => {
      main_frame.on_load = () => {};
      main_frame.special_pages['https://fixture.test/database-only'] = '<!doctype html><body>Database persistence fixture</body>';
      await main_frame.navigate_to('https://fixture.test/database-only');
    });
    const reloaded = JSON.parse(await page.evaluate(() => main_frame.eval_js(`(async () => {
      const done = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      let existed = true;
      const request = indexedDB.open('fixture-idb');
      request.onupgradeneeded = () => { existed = false; };
      const database = await done(request);
      const value = existed ? await done(database.transaction('records').objectStore('records').get(1)) : null;
      database.close();
      return JSON.stringify({existed, name: value?.name ?? null});
    })()`)));
    const survivedReload = reloaded.existed;
    assert.equal(survivedReload, !storageDenied, "IndexedDB persistence did not match the storage capability");
    assert.equal(reloaded.name, storageDenied ? null : 'alpha');
    if (target.startsWith("file:")) assert.deepEqual(requests.filter(url => /^https?:/.test(url)), [], "The standalone fixture made a direct HTTP request");
    assert.deepEqual(browserErrors, [], "The browser reported an unexpected runtime error");
    console.log(JSON.stringify({storageDenied, survivedReload, ...result}));
    await context.close();
  }
} finally { await browser.close(); }
