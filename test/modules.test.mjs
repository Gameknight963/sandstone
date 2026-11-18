import test from "node:test";
import assert from "node:assert/strict";
import { ImportMap, ModuleLoader, module_dependencies } from "../src/frame/modules.mjs";
import { rewrite_source } from "../src/frame/rewrite/javascript.mjs";

test("Import maps resolve exact names, prefixes, URL keys and longest matching scopes", () => {
  const map = new ImportMap();
  map.add({imports: {library: "lib.js", "pkg/": "./packages/", "/old.js": "./new.js", blocked: null}, scopes: {
    "./nested/": {library: "./v2.js"}, "./nested/deeper/": {library: "./v3.js"}
  }}, "https://example.com/app/index.html");
  assert.equal(map.resolve("library", "https://example.com/entry.js"), "https://example.com/app/lib.js");
  assert.equal(map.resolve("pkg/part.js", "https://example.com/entry.js"), "https://example.com/app/packages/part.js");
  assert.equal(map.resolve("/old.js", "https://example.com/entry.js"), "https://example.com/app/new.js");
  assert.equal(map.resolve("library", "https://example.com/app/nested/entry.js"), "https://example.com/app/v2.js");
  assert.equal(map.resolve("library", "https://example.com/app/nested/deeper/entry.js"), "https://example.com/app/v3.js");
  assert.throws(() => map.resolve("blocked", "https://example.com/"), /blocked/i);
  assert.throws(() => map.resolve("missing", "https://example.com/"), /Unmapped/);
  assert.throws(() => map.resolve("pkg/../../escape", "https://example.com/"), /escapes/);
  map.add({imports: {library: "/replacement.js"}}, "https://example.com/");
  assert.equal(map.resolve("library", "https://example.com/new.js"), "https://example.com/app/lib.js");
});

test("Module parsing discovers re-exports and JSON attributes without eagerly fetching dynamic imports", () => {
  assert.deepEqual(module_dependencies(`
    import {value} from './dep.js';
    export * from './other.js';
    export {default as data} from './data.json' with {type: 'json'};
    const later = () => import('./lazy.js');
  `), [
    {specifier: "./dep.js", type: "javascript"}, {specifier: "./other.js", type: "javascript"},
    {specifier: "./data.json", type: "json"}
  ]);
});

test("Module rewriting preserves local imports and dynamic import argument syntax", () => {
  const source = `
    import {fetch} from './dependency.js';
    export * from './reexport.js';
    const meta = import.meta;
    const lazy = import /*keep*/ ((location));
    const data = import('./data.json', {with: {type: 'json'}});
    fetch(window.location);
  `;
  const rewritten = rewrite_source(source, ["location", "fetch", "window"], {
    module: true, url: "https://example.com/main.js", resolve: specifier => new URL(specifier, "https://example.com/main.js").href
  });
  assert.match(rewritten, /from "https:\/\/example.com\/dependency.js"/);
  assert.match(rewritten, /from "https:\/\/example.com\/reexport.js"/);
  assert.match(rewritten, /__ctx__\.__module_meta__\("https:\/\/example.com\/main.js"\)/);
  assert.match(rewritten, /__ctx__\.__import__\.bind\(null,"https:\/\/example.com\/main.js"\) \/\*keep\*\/ \(\(__ctx__\.location\)\)/);
  assert.match(rewritten, /fetch\(__ctx__\.window.location\)/);
  rewrite_source(rewritten, [], {module: true});
});

function environment(sources) {
  const requests = [];
  const blobs = new Map();
  const mappings = new Map();
  const loader = new ModuleLoader({
    async fetch(url, options) {
      requests.push({url, ...options});
      const fixture = sources[url];
      if (fixture === undefined) return new Response("missing", {status: 404});
      const response = new Response(typeof fixture === "string" ? fixture : fixture.source);
      if (typeof fixture === "object") Object.defineProperty(response, "url", {value: fixture.url});
      return response;
    },
    rewrite: (source, options) => rewrite_source(source, ["window", "location"], options),
    createURL(source, type, original) {
      const url = "blob:test/" + blobs.size;
      blobs.set(url, {source, type, original});
      return url;
    },
    register(imports) { for (const entry of Object.entries(imports)) mappings.set(...entry); },
    execute: async blob => ({blob})
  });
  return {loader, requests, blobs, mappings};
}

test('Dynamic imports convert specifiers once and snapshot attributes before resolving a live base',async()=>{
  const env=environment({'https://example.com/options/entry.js':'export default 7;'}),events=[];let base='https://example.com/start/';
  const specifier={toString(){events.push('specifier');base='https://example.com/converted/';return './entry.js';}};
  const options={get with(){events.push('with');base='https://example.com/options/';return {};}};
  await env.loader.import(specifier,()=>{events.push('base');return base;},options);
  assert.deepEqual(events,['specifier','with','base']);
  assert.equal(env.requests[0].url,'https://example.com/options/entry.js');
  for(const options of [null,3,{with:null},{with:3},{with:{type:3}},{with:{unsupported:'value'}}])await assert.rejects(env.loader.import('./invalid.js',base,options),TypeError);
  await assert.rejects(env.loader.import(Symbol('specifier'),base),TypeError);
  assert.equal(env.requests.length,1);
});

test("Module graphs register complete cyclic dependencies and cache module identity", async () => {
  const env = environment({
    "https://example.com/a.js": "import {b} from './b.js'; export const a = () => b;",
    "https://example.com/b.js": "import {a} from './a.js'; export const b = () => a;"
  });
  const first = await env.loader.import("./a.js", "https://example.com/page");
  const second = await env.loader.import("./a.js", "https://example.com/page");
  assert.equal(first.blob, second.blob);
  assert.equal(env.requests.length, 2);
  assert.equal(env.mappings.size, 2);
  assert.match(env.blobs.get(first.blob).source, /sandstone:module:/);
  assert.equal(env.blobs.get(first.blob).type, "text/javascript");
});

test("Redirected modules resolve dependencies and metadata against the final URL", async () => {
  const env = environment({
    "https://example.com/start.js": {url: "https://cdn.test/assets/main.js", source: "export {value} from './dep.js'; export const url = import.meta.url;"},
    "https://cdn.test/assets/dep.js": "export const value = 42;"
  });
  const record = await env.loader.prepare_url("./start.js", "https://example.com/");
  const compiled = env.blobs.get(record.blob).source;
  assert.match(compiled, /blob:test\//);
  assert.equal(env.requests[1].url, "https://cdn.test/assets/dep.js");
  assert.match(compiled, /__module_meta__\("https:\/\/cdn.test\/assets\/main.js"\)/);
  assert.equal(env.loader.meta(record.url).resolve("./image.png"), "https://cdn.test/assets/image.png");
});

test("Inline modules use the document base and JSON modules work without native import attributes", async () => {
  const env = environment({"https://example.com/assets/data.json": '{"value":42}'});
  const record = await env.loader.prepare_inline("import data from './data.json' with {type:'json'}; window.data=data;", "https://example.com/assets/page");
  assert.match(env.blobs.get(record.blob).source, /__ctx__.window.data=data/);
  const json = [...env.blobs.values()].find(blob => blob.original.endsWith('data.json'));
  assert.equal(json.type, "text/javascript");
  assert.match(json.source, /export default __ctx__\.__json_module__/);
  assert.doesNotMatch(env.blobs.get(record.blob).source, /with\s*\{/);
  assert.equal(env.requests[0].url, "https://example.com/assets/data.json");
});

test("Failed graph preparation cannot fall through to a native remote import or poison later graphs", async () => {
  const env = environment({"https://example.com/good.js": "export const value=1;"});
  await assert.rejects(env.loader.import("./missing.js", "https://example.com/"), /404/);
  assert.equal(env.mappings.size, 0);
  assert.equal(env.blobs.size, 0);
  const result = await env.loader.import("./good.js", "https://example.com/");
  assert.match(result.blob, /^blob:test\//);
});

test("Acyclic graphs use direct blob imports and need no native import-map support", async () => {
  const env = environment({
    "https://example.com/root.js": "export {value} from './leaf.js';",
    "https://example.com/leaf.js": "export const value=1;"
  });
  const record = await env.loader.prepare_url("./root.js", "https://example.com/");
  assert.equal(env.mappings.size, 0);
  assert.match(env.blobs.get(record.blob).source, /from "blob:test\/0"/);
  assert.doesNotMatch(env.blobs.get(record.blob).source, /from "https?:/);
});

test('Independent module graphs finish while an earlier module download is stalled', {timeout:3000}, async()=>{
  const env=environment({'https://example.com/slow.js':'export const slow=1;','https://example.com/fast.js':'export const fast=2;'});
  const fetch=env.loader.fetch;let release;
  const held=new Promise(resolve=>release=resolve);
  env.loader.fetch=async(url,options)=>{if(url.endsWith('/slow.js'))await held;return fetch(url,options);};
  let slowFinished=false;
  const slow=env.loader.prepare_url('./slow.js','https://example.com/').then(record=>{slowFinished=true;return record;});
  try{const fast=await env.loader.prepare_url('./fast.js','https://example.com/');assert.ok(fast.blob);assert.equal(slowFinished,false);}
  finally{release();await slow;}
});

test('Concurrent cyclic graph preparation shares fetches, blobs and import-map identity',async()=>{
  const env=environment({'https://example.com/a.js':"export {b} from './b.js'; export const a=1;",'https://example.com/b.js':"export {a} from './a.js'; export const b=2;"});
  const [a,b,again]=await Promise.all([env.loader.prepare_url('./a.js','https://example.com/'),env.loader.prepare_url('./b.js','https://example.com/'),env.loader.prepare_url('./a.js','https://example.com/')]);
  assert.equal(a,again);assert.equal(a.blob,again.blob);assert.notEqual(a.blob,b.blob);
  assert.equal(env.requests.length,2);assert.equal(env.blobs.size,2);assert.equal(env.mappings.size,2);
  assert.equal((await env.loader.prepare_url('./b.js','https://example.com/')).blob,b.blob);
});
