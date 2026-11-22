import test from 'node:test';
import assert from 'node:assert/strict';
import {prepare_worker_scripts} from '../src/host/worker_scripts.mjs';

const creator_url='https://worker.test/page',url='https://worker.test/entry.js';
const response=(body,url,headers={})=>{const value=new Response(body,{headers:{'content-type':'text/javascript',...headers}});Object.defineProperty(value,'url',{value:url});return value;};
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};

test('Retained classic script preparation uses creator entry requests and redirected import bases and policies',async()=>{
  const calls=[],final='https://worker.test/assets/entry.js';
  const prepared=await prepare_worker_scripts({url,creator_url,referrer_policy:'no-referrer',options:{credentials:'omit'}},{fetch:async(target,init,context)=>{
    calls.push({target,init,context});
    if(target===url)return response('importScripts("./runtime.js","https://cdn.test/other.js","./missing.js");',final,{'referrer-policy':'origin'});
    if(target.endsWith('missing.js'))return new Response('missing',{status:404});
    return response('// imported',target);
  }});
  assert.equal(prepared.url,final);assert.equal(prepared.referrer_policy,'origin');
  assert.equal(prepared.sources[final],prepared.source);assert.equal(prepared.sources['https://worker.test/assets/runtime.js'],'// imported');
  assert.equal(prepared.sources['https://worker.test/assets/missing.js'],false);assert.equal(prepared.source_cross_origins['https://cdn.test/other.js'],true);
  assert.equal(calls[0].init.credentials,'same-origin');assert.equal(calls[0].init.destination,'sharedworker');assert.equal(calls[0].init.referrer,creator_url);assert.equal(calls[0].init.referrerPolicy,'no-referrer');
  for(const call of calls.slice(1)){assert.equal(call.init.credentials,'include');assert.equal(call.init.mode,'no-cors');assert.equal(call.init.referrer,final);assert.equal(call.init.referrerPolicy,'origin');assert.deepEqual(call.context,{entry:false,url:final});}
});

test('Module preparation retains credentials, validates MIME and leaves dependency fetching to its runtime',async()=>{
  const calls=[];
  const prepared=await prepare_worker_scripts({url,creator_url,options:{type:'module',credentials:'include'}},{fetch:async(target,init)=>{calls.push(init);return response('import "./deferred.js";',target);}});
  assert.equal(calls.length,1);assert.equal(calls[0].credentials,'include');assert.equal(prepared.type,'module');assert.equal(Object.keys(prepared.sources).length,1);
  let cancelled=false;
  await assert.rejects(prepare_worker_scripts({url,creator_url,options:{type:'module'}},{fetch:()=>Promise.resolve(response(new ReadableStream({cancel(){cancelled=true;}}),url,{'content-type':'text/plain'}))}),/MIME/);
  assert.equal(cancelled,true);
  await assert.rejects(prepare_worker_scripts({url,creator_url},{fetch:async()=>response('', 'https://foreign.test/entry.js')}),{name:'SecurityError'});
});

test('Data URLs and captured Blob imports stay local, including fragment aliases and missing local dependencies',async()=>{
  let relay=0;const fetch=()=>{relay++;throw new Error('Unexpected relay request');};
  const data='data:text/javascript,'+encodeURIComponent('globalThis.loaded=true;');
  const prepared=await prepare_worker_scripts({url:'blob:null/entry',creator_url,local_source:{source:'importScripts('+JSON.stringify(data)+',"blob:null/child#one","blob:null/child#two","blob:null/missing");',type:'text/javascript'},local_sources:{'blob:null/child':{source:new Blob(['// captured'],{type:'text/javascript'})}}},{fetch});
  assert.equal(prepared.sources[data],'globalThis.loaded=true;');assert.equal(prepared.sources['blob:null/child#one'],'// captured');assert.equal(prepared.sources['blob:null/child#two'],'// captured');assert.equal(prepared.sources['blob:null/missing'],false);
  const standalone=await prepare_worker_scripts({url:data,creator_url,options:{type:'module'}},{fetch});assert.equal(standalone.source,'globalThis.loaded=true;');assert.equal(relay,0);
  await assert.rejects(prepare_worker_scripts({url:'data:text/plain,0',creator_url,options:{type:'module'}},{fetch}),/MIME/);
  await assert.rejects(prepare_worker_scripts({url,creator_url,local_source:{source:'override'}},{fetch}),{name:'TypeError'});
  assert.equal(relay,0);
});

test('Preparation snapshots options and captured local bodies before asynchronous relay work',async()=>{
  const held=deferred(),input={url,creator_url,options:{type:'classic'},local_sources:{'blob:null/child':{source:'// original'}}};
  const preparing=prepare_worker_scripts(input,{fetch:()=>held.promise});
  input.url='https://foreign.test/other';input.options.type='module';input.local_sources['blob:null/child'].source='// changed';
  held.resolve(response('importScripts("blob:null/child");',url));const prepared=await preparing;
  assert.equal(prepared.type,'classic');assert.equal(prepared.sources['blob:null/child'],'// original');
});

test('Cancellation rejects promptly and cancels late responses even when a transport ignores its signal',async()=>{
  const controller=new AbortController(),held=deferred(),reason={aborted:true};let cancelled=false;
  const preparing=prepare_worker_scripts({url,creator_url},{fetch:()=>held.promise,signal:controller.signal});
  controller.abort(reason);await assert.rejects(preparing,error=>error===reason);
  held.resolve(response(new ReadableStream({cancel(){cancelled=true;}}),url));await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,true);
  const synchronous=new AbortController();
  await assert.rejects(prepare_worker_scripts({url,creator_url},{signal:synchronous.signal,fetch:()=>{synchronous.abort(reason);return Promise.reject(new Error('late failure'));}}),error=>error===reason);
});

test('Cancellation releases a stalled source reader without awaiting its underlying cancellation promise',async()=>{
  const controller=new AbortController(),reading=deferred(),reason=new Error('stop');let cancelled=false;
  const body=new ReadableStream({pull(){reading.resolve();},cancel(){cancelled=true;return new Promise(()=>{});}});
  const preparing=prepare_worker_scripts({url,creator_url},{signal:controller.signal,fetch:async()=>response(body,url)});
  await reading.promise;controller.abort(reason);await assert.rejects(preparing,error=>error===reason);assert.equal(cancelled,true);
});
