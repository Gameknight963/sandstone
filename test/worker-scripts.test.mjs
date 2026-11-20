import test from "node:test";
import assert from "node:assert/strict";
import { worker_imports, prefetch_worker_scripts } from "../src/frame/worker_scripts.mjs";

test('Recognized asynchronous AMD imports do not execute discovery probes and shadowed transports remain conservative',()=>{
  const source=`function load(url){return new Promise(done=>{if('document' in self)document.head.append(document.createElement('script'));else self.moduleURL=url,importScripts(url),done()});}`;
  const base='https://site.test/worker.js';assert.equal(worker_imports(source,base).dynamic,true);assert.deepEqual(worker_imports(source,base,{asyncLoaders:true}),{urls:[],dynamic:false});
  for(const prefix of ['const Promise=CustomPromise;','const importScripts=customImport;','function local(self){}','with (object) {}','eval(source);'])assert.equal(worker_imports(prefix+source,base,{asyncLoaders:true}).dynamic,true);
  assert.deepEqual(worker_imports(source+'importScripts("./ordinary.js");',base,{asyncLoaders:true}),{urls:['https://site.test/ordinary.js'],dynamic:false});
});

test('Classic service-worker AMD declarations preload dependencies without executing startup code',async()=>{
  const loader=`const table={};function load(url){return new Promise(done=>{if('document' in self)document.head.append(document.createElement('script'));else self.moduleURL=url,importScripts(url),done()});}`;
  const source=loader+`define(['exports','./library'],exports=>{throw new Error('Must not execute');});`,seen=[];
  const result=await prefetch_worker_scripts(source,'https://app.test/worker.js',async url=>{seen.push(url);const response=new Response(url.endsWith('/library.js')?`define(['exports','./nested.js'],exports=>{});`:`define(['exports'],exports=>{});`);Object.defineProperty(response,'url',{value:url.endsWith('/library.js')?'https://cdn.test/final/library.js':url});return response;},new Map(),new Map(),undefined,{staticAMD:true});
  assert.deepEqual(seen,['https://app.test/library.js','https://app.test/nested.js']);assert.equal(result.dynamic,false);assert.equal(result.source_urls.get('https://app.test/library.js'),'https://cdn.test/final/library.js');
  assert.equal(worker_imports(loader+`define(['require'],require=>require(computedName));`,'https://app.test/worker.js',{staticAMD:true}).dynamic,true);
});

test('Worker discovery parses native legacy arrow initializers without executing the worker',()=>{
  assert.deepEqual(worker_imports('for(var callback=()=>1 in {}){};importScripts("./chunk.js");throw new Error("must not execute");','https://site.test/worker.js'),{urls:['https://site.test/chunk.js'],dynamic:false});
});

test("Classic worker discovery finds literal and constant imports without executing source", () => {
  const source = `
    const root = './lib/';
    importScripts(root + 'one.js', './two.js');
    self.importScripts(\`./three.js\`);
    throw new Error('must never execute');
  `;
  assert.deepEqual(worker_imports(source, "https://example.com/workers/main.js"), {
    urls: ["https://example.com/workers/lib/one.js", "https://example.com/workers/two.js", "https://example.com/workers/three.js"], dynamic: false
  });
  assert.equal(worker_imports("importScripts('./' + choose() + '.js')", "https://example.com/main.js").dynamic, true);
  assert.equal(worker_imports("const name='outer'; function inner(name){importScripts(name)}", "https://example.com/main.js").dynamic, true);
});

test("Nested importScripts resolve against the worker entry URL and failures remain deferred", async () => {
  const seen = [];
  const result = await prefetch_worker_scripts("importScripts('./lib/first.js','./missing.js')", "https://example.com/workers/main.js", async url => {
    seen.push(url);
    if (url.endsWith('/missing.js')) return new Response('', {status: 404});
    return new Response(url.endsWith('/first.js') ? "importScripts('./second.js')" : "self.value=42");
  });
  assert.deepEqual(seen, ["https://example.com/workers/lib/first.js", "https://example.com/workers/missing.js", "https://example.com/workers/second.js"]);
  assert.equal(result.cache.get("https://example.com/workers/missing.js"), false);
  assert.equal(result.cache.get("https://example.com/workers/second.js"), "self.value=42");
});

test('Worker discovery reads declared lazy bundle tables without executing registration',()=>{
  const source=`throw new Error('must not run');
    registry.register(helper.getBundleURL('worker'),JSON.parse('["one","./chunks/one.js","two","two.mjs?v=1","style","style.css"]'));
    onmessage=event=>importScripts(registry.resolve(event.data));`;
  assert.deepEqual(worker_imports(source,'https://example.com/workers/main.js',{scriptURL:'https://example.com/assets/runtime.js'}),{
    urls:['https://example.com/assets/chunks/one.js','https://example.com/assets/two.mjs?v=1'],dynamic:true
  });
  for(const source of [
    `registry.register(helper.getBundleURL('worker'),JSON.parse('[invalid'))`,
    `registry.register(helper.getBundleURL('worker'),['one','./one.js','odd'])`,
    `registry.register(helper.getBundleURL('worker'),JSON.parse(loadManifest()))`,
    `registry.register(otherFunction(),['one','./one.js'])`
  ])assert.deepEqual(worker_imports(source,'https://example.com/main.js').urls,[]);
});

test('Lazy bundle discovery uses the imported runtime response URL and avoids refetching the worker entry',async()=>{
  const base='https://example.com/workers/main.js',seen=[];
  const result=await prefetch_worker_scripts("importScripts('./runtime.js')",base,async url=>{
    seen.push(url);
    const response=new Response(url.endsWith('/runtime.js')?
      `registry.register(bundle.getBundleURL('worker'),['self','../workers/main.js','late','./late.js']);`:'self.loaded=true;');
    if(url.endsWith('/runtime.js'))Object.defineProperty(response,'url',{value:'https://example.com/assets/runtime.js'});
    return response;
  });
  assert.deepEqual(seen,['https://example.com/workers/runtime.js','https://example.com/assets/late.js']);
  assert.equal(result.source_urls.get('https://example.com/workers/runtime.js'),'https://example.com/assets/runtime.js');
  assert.equal(result.cache.get(base),"importScripts('./runtime.js')");
});
