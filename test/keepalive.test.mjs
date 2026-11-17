import test from 'node:test';
import assert from 'node:assert/strict';
import {BeaconQueue} from '../src/host/beacon.mjs';
import {KeepaliveRequests} from '../src/host/keepalive.mjs';
import {serialize_request} from '../src/frame/polyfill/request.mjs';
import {create_beacon_sender} from '../src/frame/beacon.mjs';
import {keepalive_budget,reserve_keepalive} from '../src/frame/keepalive_budget.mjs';

const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function setup(fetch,options={}) {
  const queue=new BeaconQueue({fetch:async()=>new Response(null,{status:204}),cookies:()=>null,...options});
  const context=queue.register('frame',{url:'https://old.test/page',top_url:'https://old.test/'});
  const pool=new KeepaliveRequests({queue,fetch,cookies:()=>['cookies'],...options});
  return {queue,pool,context};
}

test('Keepalive responses stream to readers while network completion frees shared beacon quota',async()=>{
  let stream;
  const {queue,pool,context}=setup(async()=>new Response(new ReadableStream({start(controller){stream=controller;}})));
  const response=await pool.open(context,'request','https://old.test/api',{method:'POST',body:new ArrayBuffer(65536),keepalive:true});
  assert.equal(response.has_body,true);
  assert.equal(await queue.send(context,'https://old.test/beacon',new Blob(['x'])),false);
  stream.enqueue(new Uint8Array([1,2]));stream.close();
  await pool.completed(context,'request');
  assert.equal(queue.contexts.get(context).queued,0);
  assert.notEqual(await queue.send(context,'https://old.test/beacon',new Blob(['x'])),false);
  assert.deepEqual(await pool.read(context,'request'),{done:false,value:new Uint8Array([1,2])});
  assert.deepEqual(await pool.read(context,'request'),{done:true});
  assert.equal(pool.requests.size,0);
});

test('Keepalive retains the original document and drains responses after retirement before headers',async()=>{
  let respond,seen;
  const {queue,pool,context}=setup(async(url,options,source)=>{
    seen={url,options,source};return new Promise(resolve=>{respond=resolve;});
  },{grace:1});
  const opened=pool.open(context,'request','https://other.test/api',{body:new Blob(['saved']),method:'POST'});
  queue.retire('frame');pool.retire('frame');await tick();await tick();
  assert.equal(queue.contexts.has(context),false);
  assert.equal(seen.source.url,'https://old.test/page');assert.equal(seen.options.signal.aborted,false);
  respond(new Response('discarded'));
  assert.equal((await opened).has_body,false);await tick();
  assert.equal(pool.requests.size,0);
});

test('Late unload requests use retired contexts and attached responses preserve aborts and errors',async()=>{
  let stream,signal;
  const {queue,pool,context}=setup(async(url,options)=>{
    signal=options.signal;return new Response(new ReadableStream({start(controller){stream=controller;}}));
  });
  const response=await pool.open(context,'active','https://old.test/api',{body:new Blob(['x'])});
  assert.equal(response.has_body,true);
  const reading=pool.read(context,'active');
  pool.abort(context,'active');
  await assert.rejects(reading,{name:'AbortError'});assert.equal(signal.aborted,true);
  assert.equal(queue.contexts.get(context).queued,0);
  queue.retire('frame');pool.retire('frame');
  assert.equal((await pool.open(context,'late','https://old.test/api',{})).has_body,false);
  stream.enqueue(new Uint8Array([1]));stream.close();await tick();
  assert.equal(pool.requests.size,0);
});

test('Keepalive failures, timeouts, invalid contexts and oversized bodies release every lease',async()=>{
  const {queue,pool,context}=setup(async(url,options)=>new Promise((resolve,reject)=>{
    options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});
  }),{timeout:5});
  await assert.rejects(pool.open(context,'large','https://old.test/',{body:new ArrayBuffer(65537)}),TypeError);
  await assert.rejects(pool.open('missing','bad','https://old.test/',{}),TypeError);
  await assert.rejects(pool.open(context,'protocol','file:///local',{}),TypeError);
  const pending=pool.open(context,'timeout','https://old.test/',{body:new Blob(['bytes'])});
  const checked=assert.rejects(pending,{name:'TimeoutError'});
  await new Promise(resolve=>setTimeout(resolve,10));await checked;
  assert.equal(queue.contexts.get(context).queued,0);assert.equal(pool.requests.size,0);
});

test('Retiring a pending response read keeps its transfer tracked until timeout',async()=>{
  let canceled=false;
  const {queue,pool,context}=setup(async()=>new Response(new ReadableStream({cancel(){canceled=true;}})),{timeout:5});
  await pool.open(context,'request','https://old.test/api',{body:new Blob(['saved'])});
  const pending=pool.read(context,'request');pool.retire('frame');
  assert.deepEqual(await pending,{done:true});assert.equal(pool.requests.size,1);
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(canceled,true);assert.equal(pool.requests.size,0);assert.equal(queue.contexts.get(context).queued,0);
});

test('A transport resolving headers after abort cannot resurrect a keepalive response',async()=>{
  let respond,canceled=false;
  const {queue,pool,context}=setup(async()=>new Promise(resolve=>{respond=resolve;}));
  const opened=pool.open(context,'request','https://old.test/api',{body:new Blob(['saved'])});
  pool.abort(context,'request');
  respond(new Response(new ReadableStream({cancel(){canceled=true;}})));
  await assert.rejects(opened,{name:'AbortError'});
  assert.equal(canceled,true);assert.equal(pool.requests.size,0);assert.equal(queue.contexts.get(context).queued,0);
});

test('Keepalive serialization snapshots bodies and reserves bytes before its first asynchronous boundary',async()=>{
  const bytes=new Uint8Array([1,2,3]);let reserved;
  const pending=serialize_request('/api',{method:'POST',body:bytes,keepalive:true},'https://site.test/',undefined,size=>{reserved=size;});
  assert.equal(reserved,3);bytes.fill(9);
  const request=await pending;
  assert.equal(request.options.keepalive,true);
  assert.deepEqual([...new Uint8Array(await request.options.body.arrayBuffer())],[1,2,3]);
  const form=new FormData();form.append('field','saved');
  const multipart=await serialize_request('/api',{method:'POST',body:form,keepalive:true},'https://site.test/');
  form.set('field','changed');
  const parsed=await new Response(multipart.options.body,{headers:multipart.options.headers}).formData();
  assert.equal(parsed.get('field'),'saved');
  for(const value of ['text',new URLSearchParams({q:'a b'})]){
    const normalized=await serialize_request('/api',{method:'POST',body:value,keepalive:true},'https://site.test/');
    assert.equal(normalized.options.headers['content-type'],new Request('https://site.test/',{method:'POST',body:value}).headers.get('content-type'));
  }
  await assert.rejects(serialize_request('/api',{method:'POST',body:new ReadableStream(),keepalive:true},'https://site.test/'),TypeError);
});

test('Frame keepalive and beacon reservations share the exact byte limit and release once',async()=>{
  const release=reserve_keepalive(65536);
  const send=create_beacon_sender({base:()=> 'https://site.test/',budget:keepalive_budget,dispatch:()=>{}});
  assert.equal(send('/beacon','x'),false);
  assert.throws(()=>reserve_keepalive(1),TypeError);
  release();release();assert.equal(keepalive_budget.queued,0);
  assert.equal(send('/beacon','x'),true);await tick();assert.equal(keepalive_budget.queued,0);
});

test('Prebuilt keepalive Request bodies are retained when the browser exposes a null body stream',async()=>{
  const NativeRequest=globalThis.Request;
  try {
    globalThis.Request=class extends NativeRequest {get body(){return null;}};
    const form=new FormData();form.append('field','saved');
    const input=new Request('https://site.test/api',{method:'POST',body:form,keepalive:true});
    const request=await serialize_request(input,{},'https://site.test/');
    const parsed=await new Response(request.options.body,{headers:request.options.headers}).formData();
    assert.equal(parsed.get('field'),'saved');assert.equal(request.options.keepalive,true);
  } finally {globalThis.Request=NativeRequest;}
});
