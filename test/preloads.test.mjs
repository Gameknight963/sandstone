import test from 'node:test';import assert from 'node:assert/strict';
import {ResourcePreloads} from '../src/preloads.mjs';
const options={destination:'script',mode:'no-cors',credentials:'include'};
test('A document preload supplies the first matching response even when HTTP caching is disabled',async()=>{
  const cache=new ResourcePreloads();let calls=0;
  const response=()=>{calls++;const response=new Response('source',{headers:{'cache-control':'no-store','content-type':'text/javascript'}});Object.defineProperty(response,'url',{value:'https://app.test/final.js'});return response;};
  await cache.load('https://app.test/script.js',options,'document',response);await cache.load('https://app.test/script.js',options,'document',response);assert.equal(calls,1);
  assert.equal(cache.consume('https://app.test/script.js',options,'other'),undefined);assert.equal(cache.consume('https://app.test/script.js',{...options,mode:'cors'},'document'),undefined);
  for(const extra of [{method:'POST'},{method:'HEAD'},{keepalive:true},{body:'payload'},{headers:{'x-request':'custom'}}])assert.equal(cache.consume('https://app.test/script.js',{...options,...extra},'document'),undefined);
  const hit=await cache.consume('https://app.test/script.js',options,'document');assert.equal(hit.url,'https://app.test/final.js');const copy=hit.clone();assert.equal(copy.url,hit.url);assert.equal(await copy.text(),'source');assert.equal(await hit.text(),'source');assert.equal(cache.bytes,0);assert.equal(cache.consume('https://app.test/script.js',options,'document'),undefined);
});
test('Requests can consume a pending preload and failures release every buffered byte',async()=>{
  const cache=new ResourcePreloads();let finish;
  const pending=cache.load('https://app.test/a',options,'document',()=>new Promise(resolve=>finish=resolve));const consumed=cache.consume('https://app.test/a',options,'document');finish(new Response('ready'));await pending;assert.equal(await(await consumed).text(),'ready');assert.equal(cache.bytes,0);
  const failed=cache.load('https://app.test/b',options,'document',()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(8));controller.error(new Error('failed'));}})));
  await assert.rejects(failed,/failed/);assert.equal(cache.bytes,0);assert.equal(cache.entries.size,0);
});
test('Preload memory and entry budgets drop reuse without truncating or failing a successful hint',async()=>{
  const cache=new ResourcePreloads({maxBytes:4,maxEntries:1});
  const large=await cache.load('https://app.test/large',options,'doc',()=>new Response('12345'));assert.equal(large.status,200);assert.equal(cache.bytes,0);assert.equal(await cache.consume('https://app.test/large',options,'doc'),undefined);
  await cache.load('https://app.test/one',options,'doc',()=>new Response('123'));await cache.load('https://app.test/two',options,'doc',()=>new Response('45'));
  assert.equal(cache.consume('https://app.test/one',options,'doc'),undefined);assert.equal(cache.bytes,2);assert.equal(await(await cache.consume('https://app.test/two',options,'doc')).text(),'45');assert.equal(cache.bytes,0);
});
