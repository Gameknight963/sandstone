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

function environment(sources,options={}) {
  const requests = [];
  const blobs = new Map();
  const mappings = new Map();
  const loader = new ModuleLoader({
    context:options.context,
    async fetch(url, options) {
      requests.push({url, ...options});
      const fixture = sources[url];
      if (fixture === undefined) return new Response("missing", {status: 404});
      const response = new Response(typeof fixture === "string" ? fixture : fixture.source,{headers:fixture.headers});
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

test('Module dependencies inherit response policies and final parent URLs, separately from the entry referrer',async()=>{
  const env=environment({
    'https://example.com/start.js':{url:'https://cdn.test/modules/root.js',source:'import "./child.js";',headers:{'Referrer-Policy':'unsafe-url'}},
    'https://cdn.test/modules/child.js':{source:'import "./grand.js";',headers:{'Referrer-Policy':'no-referrer'}},
    'https://cdn.test/modules/grand.js':'export const value=1;'
  },{context:()=>({referrer:'https://example.com/page',referrerPolicy:'origin'})});
  await env.loader.prepare_url('./start.js','https://example.com/',{credentials:'include'});
  assert.deepEqual(env.requests,[
    {url:'https://example.com/start.js',credentials:'include',referrer:'https://example.com/page',referrerPolicy:'origin'},
    {url:'https://cdn.test/modules/child.js',credentials:'include',referrer:'https://cdn.test/modules/root.js',referrerPolicy:'unsafe-url'},
    {url:'https://cdn.test/modules/grand.js',credentials:'include',referrer:'https://cdn.test/modules/child.js',referrerPolicy:'no-referrer'}
  ]);
});

test('Delayed imports retain their module record context without consulting changed document settings',async()=>{
  let unavailable=false;
  const env=environment({
    'https://example.com/start.js':{url:'https://cdn.test/modules/root.js',source:'export const load=()=>import("./late.js");export const url=import.meta.url;',headers:{'Referrer-Policy':'no-referrer'}},
    'https://cdn.test/modules/late.js':'export default 1;'
  },{context:()=>{if(unavailable)throw new Error('Current document settings were read');return {referrer:'https://example.com/page',referrerPolicy:'unsafe-url'}}});
  const entry=await env.loader.prepare_url('./start.js','https://example.com/');
  const code=env.blobs.get(entry.blob).source;
  assert.ok(code.includes('__import__.bind(null,'+JSON.stringify({key:entry.key})+')'));
  assert.ok(code.includes('__module_meta__("https://cdn.test/modules/root.js")'));
  unavailable=true;
  await env.loader.import('./late.js',{key:entry.key});
  assert.deepEqual(env.requests[1],{url:'https://cdn.test/modules/late.js',credentials:'same-origin',referrer:'https://cdn.test/modules/root.js',referrerPolicy:'no-referrer'});
  await env.loader.prepare_url('./start.js','https://example.com/');
  assert.equal(env.requests.length,2);
});

test('Inline modules sharing a base URL retain independent policies for delayed imports',async()=>{
  const env=environment({'https://example.com/assets/a.js':'export default 1;','https://example.com/assets/b.js':'export default 2;'});
  const a=await env.loader.prepare_inline('export const load=()=>import("./a.js");','https://example.com/assets/','same-origin',{referrerPolicy:'no-referrer'});
  const b=await env.loader.prepare_inline('export const load=()=>import("./b.js");','https://example.com/assets/','same-origin',{referrerPolicy:'unsafe-url'});
  assert.notEqual(a.key,b.key);assert.equal(a.url,b.url);
  await env.loader.import('./a.js',{key:a.key});await env.loader.import('./b.js',{key:b.key});
  assert.deepEqual(env.requests.map(({referrer,referrerPolicy})=>({referrer,referrerPolicy})),[
    {referrer:'https://example.com/assets/',referrerPolicy:'no-referrer'},
    {referrer:'https://example.com/assets/',referrerPolicy:'unsafe-url'}
  ]);
});

test('Invalid response policies preserve inherited module policy and explicit entry options take precedence',async()=>{
  const env=environment({
    'https://example.com/root.js':{source:'import "./child.js";',headers:{'Referrer-Policy':'invalid-policy'}},
    'https://example.com/child.js':'export default 1;'
  },{context:()=>({referrer:'https://example.com/current',referrerPolicy:'no-referrer'})});
  await env.loader.prepare_url('./root.js','https://example.com/',{referrer:'https://example.com/chosen',referrerPolicy:'origin'});
  assert.equal(env.requests[0].referrer,'https://example.com/chosen');
  assert.equal(env.requests[0].referrerPolicy,'origin');
  assert.equal(env.requests[1].referrer,'https://example.com/root.js');
  assert.equal(env.requests[1].referrerPolicy,'origin');
});

test('CSS modules compile as shared stylesheet exports without parsing CSS as JavaScript or following imports',async()=>{
  const env=environment({
    'https://example.com/main.js':'export {default as sheet} from "./theme.css" with {type:"css"};',
    'https://example.com/theme.css':{source:'@import "./ignored.css";body{color:red;background:url(./image.png)}',headers:{'Content-Type':'TEXT/CSS; charset=utf-8','Referrer-Policy':'no-referrer'}}
  });
  await env.loader.prepare_url('./main.js','https://example.com/');
  const first=await env.loader.import('./theme.css','https://example.com/',{with:{type:'css'}});
  const second=await env.loader.import('./theme.css','https://example.com/',{with:{type:'css'}});
  assert.equal(first.blob,second.blob);
  assert.equal(env.requests.length,2);
  const compiled=env.blobs.get(first.blob);
  assert.equal(compiled.type,'text/javascript');
  assert.match(compiled.source,/export default __ctx__\.__css_module__/);
  assert.ok(compiled.source.includes(JSON.stringify('https://example.com/theme.css')));
  assert.deepEqual(module_dependencies('import sheet from "./theme.css" with {type:"css"};'),[{specifier:'./theme.css',type:'css'}]);
});

test('CSS module redirects retain the final stylesheet URL and reject incorrect MIME types before execution',async()=>{
  const env=environment({'https://example.com/theme.css':{url:'https://cdn.test/styles/theme.css',source:'body{color:red}',headers:{'Content-Type':'text/css'}}});
  const entry=await env.loader.prepare_url('./theme.css','https://example.com/',{with:{type:'css'}});
  assert.ok(env.blobs.get(entry.blob).source.includes(JSON.stringify('https://cdn.test/styles/theme.css')));
  for(const type of [undefined,'text/plain','text/javascript','application/json']){
    const rejected=environment({'https://example.com/theme.css':{source:'body{color:red}',headers:type?{'Content-Type':type}:{}}});
    await assert.rejects(rejected.loader.import('./theme.css','https://example.com/',{with:{type:'css'}}),/MIME type/);
    assert.equal(rejected.blobs.size,0);
  }
});

test('Environments without CSSStyleSheet reject CSS modules before requesting them',async()=>{
  const env=environment({});env.loader.types.delete('css');
  await assert.rejects(env.loader.import('./theme.css','https://example.com/',{with:{type:'css'}}),/Unsupported module type/);
  assert.equal(env.requests.length,0);
});

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
