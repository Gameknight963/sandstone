import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import assert from "node:assert/strict";
import {createHmac} from 'node:crypto';

const testSource = await readFile(new URL("browser.playwright.js", import.meta.url), "utf8");
const dexieSource = await readFile(new URL("../node_modules/dexie/dist/dexie.js", import.meta.url), "utf8");
const axiosSource = await readFile(new URL("../node_modules/axios/dist/axios.min.js", import.meta.url), "utf8");
const verify = runInThisContext(`(${testSource})`);
const moduleTest = await readFile(new URL("modules.playwright.js", import.meta.url), "utf8");
const verifyModules = runInThisContext(`(${moduleTest})`);
const resourceTest = await readFile(new URL("resources.playwright.js", import.meta.url), "utf8");
const verifyResources = runInThisContext(`(${resourceTest})`);
const workerTest = await readFile(new URL("workers.playwright.js", import.meta.url), "utf8");
const verifyWorkers = runInThisContext(`(${workerTest})`);
const historyTest = await readFile(new URL("history.playwright.js", import.meta.url), "utf8");
const verifyHistory = runInThisContext(`(${historyTest})`);
const linkTest=await readFile(new URL('links.playwright.js',import.meta.url),'utf8');
const verifyLinks=runInThisContext(`(${linkTest})`);
const hyperlinkTest=await readFile(new URL('hyperlinks.playwright.js',import.meta.url),'utf8');
const verifyHyperlinks=runInThisContext(`(${hyperlinkTest})`);
const baseTest=await readFile(new URL('base.playwright.js',import.meta.url),'utf8');
const verifyBase=runInThisContext(`(${baseTest})`);
const cssTest = await readFile(new URL("css.playwright.js", import.meta.url), "utf8");
const verifyCSS = runInThisContext(`(${cssTest})`);
const mediaTest = await readFile(new URL("media.playwright.js", import.meta.url), "utf8");
const verifyMedia = runInThisContext(`(${mediaTest})`);
const formTest = await readFile(new URL("forms.playwright.js", import.meta.url), "utf8");
const verifyForms = runInThisContext(`(${formTest})`);
const xhrTest = await readFile(new URL("xhr.playwright.js", import.meta.url), "utf8");
const verifyXHR = runInThisContext(`(${xhrTest})`);
const cssomTest = await readFile(new URL("cssom.playwright.js", import.meta.url), "utf8");
const verifyCSSOM = runInThisContext(`(${cssomTest})`);
const cryptoTest = await readFile(new URL('crypto.playwright.js',import.meta.url),'utf8');
const verifyCrypto = runInThisContext(`(${cryptoTest})`);
const artifact = fileURLToPath(new URL("../example/bundled.html", import.meta.url));
const target = process.argv[2] || pathToFileURL(artifact).href;
async function timed(operation, label) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + " timed out")), 30000); })]); }
  finally { clearTimeout(timer); }
}
const browserChannel = process.env.BROWSER_CHANNEL || "chrome";
const browser = await chromium.launch({channel: browserChannel === "headless" ? undefined : browserChannel, headless: true});
try {
  for (const storageDenied of [false, true]) {
    const context = await browser.newContext();
    if (storageDenied) await context.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {get() { throw new DOMException("Storage denied", "SecurityError"); }});
      Object.defineProperty(window, "indexedDB", {get() { throw new DOMException("Storage denied", "SecurityError"); }});
    });
    const page = await context.newPage();
    const browserErrors = [];
    const expectedBaseWarnings=new Set();
    page.on("pageerror", error => { browserErrors.push(error.message); console.error("Browser error:", error.message); });
    page.on("console", message => {
      if(expectedBaseWarnings.has(message.text()))return;
      if (message.type() === "error") { browserErrors.push(message.text()); console.error("Browser console:",message.text()); }
    });
    const requests = [];
    page.on("request", request => requests.push(request.url()));
    const result = await timed(verify(page, target), "Browser compatibility fixture");
    const globalPatch = JSON.parse(await page.evaluate(() => main_frame.eval_js(`(async () => {
      const original = window.queueMicrotask;
      const calls = [];
      try {
        window.queueMicrotask = callback => {
          calls.push('patched');
          original(callback);
        };
        const stable = window.queueMicrotask === window.queueMicrotask;
        await new Promise(resolve => queueMicrotask(() => { calls.push('callback'); resolve(); }));
        window.queueMicrotask = original;
        const restored = window.queueMicrotask === original;
        await new Promise(resolve => window.queueMicrotask(() => { calls.push('restored'); resolve(); }));
        return JSON.stringify({stable, restored, calls});
      } finally { window.queueMicrotask = original; }
    })()`)));
    assert.deepEqual(globalPatch, {stable:true, restored:true, calls:['patched','callback','restored']});
    result.passed.push('Global function instrumentation and restoration');
    const moduleResults = await timed(verifyModules(page), "Module fixture");
    result.passed.push(...moduleResults);
    result.passed.push(...await timed(verifyResources(page), "Resource fixture"));
    result.passed.push(...await timed(verifyWorkers(page), "Worker fixture"));
    result.passed.push(...await timed(verifyCrypto(page), 'Web Crypto fixture'));
    result.passed.push(...await timed(verifyHistory(page), "History fixture"));
    result.passed.push(...await timed(verifyLinks(page), 'Link event fixture'));
    result.passed.push(...await timed(verifyHyperlinks(page), 'Hyperlink URL fixture'));
    result.passed.push(...await timed(verifyCSS(page), "CSS fixture"));
    result.passed.push(...await timed(verifyMedia(page), "Media fixture"));
    result.passed.push(...await timed(verifyForms(page), "Form fixture"));
    result.passed.push(...await timed(verifyXHR(page), "XHR fixture"));
    await page.evaluate(source => main_frame.eval_js(source), axiosSource);
    const axiosResult = JSON.parse(await timed(page.evaluate(() => main_frame.eval_js(`(async () => {
      const client=axios.create({adapter:'xhr',baseURL:'https://fixture.test/xhr-fixture/base/'});
      const json=await client.get('json',{responseType:'json'});
      const progress=[];
      const streamed=await client.get('stream',{onDownloadProgress:event=>progress.push([event.loaded,event.total])});
      const upload=[];
      await client.post('upload',new Uint8Array([1,2,3]),{onUploadProgress:event=>upload.push(event.loaded)});
      const failures={};
      for(const path of ['missing','broken','delay']) {
        try{await client.get(path,{timeout:30});}catch(error){failures[path]=error.code;}
      }
      const controller=new AbortController();
      const pending=client.get('delay',{signal:controller.signal});
      setTimeout(()=>controller.abort(),10);
      try{await pending;}catch(error){failures.cancel=error.code;}
      return JSON.stringify({json:json.data.value,text:streamed.data,progress:progress.at(-1),upload:upload.at(-1),failures});
    })()`)), "Axios XHR adapter"));
    assert.deepEqual(axiosResult,{json:42,text:'A€B',progress:[5,5],upload:3,
      failures:{missing:'ERR_BAD_REQUEST',broken:'ERR_NETWORK',delay:'ECONNABORTED',cancel:'ERR_CANCELED'}});
    result.passed.push('Axios XHR adapter JSON/progress/errors/cancellation');
    result.passed.push(...await timed(verifyCSSOM(page), "CSSOM fixture"));
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
    const cryptoReload=JSON.parse(await page.evaluate(()=>main_frame.eval_js(`(async()=>{
      const done=request=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
      let existed=true;const request=indexedDB.open('crypto-fixture');request.onupgradeneeded=()=>existed=false;
      const database=await done(request);const stored=existed?await done(database.transaction('keys').objectStore('keys').get('saved')):null;database.close();
      const signature=stored?await crypto.subtle.sign('HMAC',stored.key,new TextEncoder().encode('message')):null;
      return JSON.stringify({existed,typed:stored?stored.key instanceof CryptoKey:false,extractable:stored?.key.extractable??null,signature:signature?Array.from(new Uint8Array(signature),byte=>byte.toString(16).padStart(2,'0')).join(''):null});
    })()`)));
    assert.deepEqual(cryptoReload,storageDenied?{existed:false,typed:false,extractable:null,signature:null}:{existed:true,typed:true,extractable:false,signature:createHmac('sha256','secret').update('message').digest('hex')},'Cryptographic key persistence did not match the storage capability');
    // Chrome can replay invalid-base diagnostics when another frame is loaded.
    // Exercise those native diagnostics last, with no subsequent navigation.
    try{result.passed.push(...await timed(verifyBase(page,warnings=>warnings.forEach(message=>expectedBaseWarnings.add(message))), 'Document base fixture'));}
    finally{expectedBaseWarnings.clear();}
    if (target.startsWith("file:")) assert.deepEqual(requests.filter(url => /^https?:/.test(url)), [], "The standalone fixture made a direct HTTP request");
    assert.deepEqual(browserErrors, [], "The browser reported an unexpected runtime error");
    console.log(JSON.stringify({storageDenied, survivedReload, ...result}));
    await context.close();
  }
} finally { await browser.close(); }
