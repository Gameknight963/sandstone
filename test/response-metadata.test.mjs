import test from 'node:test';
import assert from 'node:assert/strict';
import {remember_response,response_metadata,opaque_redirect_response,consume_filtered_response} from '../src/response_metadata.mjs';
import {create_service_worker_events} from '../src/service_worker/events.mjs';

test('Internal response metadata ignores authored property overrides and retains live native headers',()=>{
  const response=remember_response(new Response('body'),{url:'https://actual.test/result',type:'cors',redirected:true});
  Object.defineProperties(response,{url:{value:'https://forged.test/'},status:{value:404},type:{value:'basic'},headers:{value:new Headers({forged:'yes'})}});
  const metadata=response_metadata(response);
  assert.equal(metadata.url,'https://actual.test/result');assert.equal(metadata.status,200);assert.equal(metadata.type,'cors');assert.equal(metadata.headers.has('forged'),false);
  metadata.headers.set('x-live','yes');assert.equal(response_metadata(response).headers.get('x-live'),'yes');
  assert.throws(()=>response_metadata({status:200}),TypeError);
});
test('A relayed opaque response cannot be laundered through respondWith by shadowing its type',async()=>{
  const events=create_service_worker_events({responseMetadata:response_metadata});
  const response=remember_response(new Response('private'),{type:'opaque',status:0});
  Object.defineProperty(response,'type',{value:'default'});
  const event=new events.FetchEvent('fetch',{request:new Request('https://app.test/data',{mode:'cors'})});
  const result=events.dispatch_event(event,view=>view.respondWith(Response.prototype.clone.call(response)));
  await assert.rejects(result.response,TypeError);
});

test('Borrowed native clones retain trusted metadata and independent bodies without copying authored properties',async()=>{
  const response=remember_response(new Response('body',{headers:{'x-original':'yes'}}),{url:'https://app.test/final#private',type:'cors',redirected:true});
  Object.defineProperties(response,{url:{get(){throw new Error('Authored URL getter');}},type:{value:'basic'},status:{value:404},headers:{value:new Headers({forged:'yes'})}});
  const copy=Response.prototype.clone.call(response),again=Response.prototype.clone.call(copy);
  assert.equal(copy.url,'https://app.test/final');assert.equal(copy.type,'cors');assert.equal(copy.status,200);assert.equal(copy.redirected,true);assert.equal(copy.ok,true);
  assert.equal(response_metadata(copy).url,'https://app.test/final#private');assert.equal(response_metadata(again).url,'https://app.test/final#private');
  assert.equal(copy.headers.get('x-original'),'yes');assert.equal(copy.headers.has('forged'),false);copy.headers.set('x-copy','yes');assert.equal(response_metadata(response).headers.has('x-copy'),false);
  assert.equal(await copy.text(),'body');assert.equal(response.bodyUsed,false);assert.equal(await again.text(),'body');assert.equal(await response.text(),'body');
  assert.throws(()=>Response.prototype.clone.call(response),TypeError);assert.throws(()=>Response.prototype.clone.call({}),TypeError);
});

test('Opaque redirect bodies stay private while clones and cache consumers retain native usage semantics',async()=>{
  const raw=remember_response(new Response('private body',{status:302,headers:{'x-private':'secret'}}),{url:'https://app.test/source#state'}),response=opaque_redirect_response(raw),copy=Response.prototype.clone.call(response);
  assert.equal(response.type,'opaqueredirect');assert.equal(response.status,0);assert.equal(response.statusText,'');assert.equal(response.url,'https://app.test/source');
  assert.equal(Object.getOwnPropertyDescriptor(Response.prototype,'body').get.call(response),null);assert.equal(await response.text(),'');assert.equal(response.bodyUsed,false);
  assert.deepEqual([...response.headers],[]);assert.throws(()=>response.headers.set('x-added','value'),TypeError);
  const body=consume_filtered_response(response);assert.equal(response.bodyUsed,true);assert.equal(await(await body).text(),'private body');
  await assert.rejects(Response.prototype.text.call(response),TypeError);assert.throws(()=>Response.prototype.clone.call(response),TypeError);assert.throws(()=>consume_filtered_response(response),TypeError);
  assert.equal(copy.bodyUsed,false);assert.equal(await copy.text(),'');assert.equal(await(await consume_filtered_response(copy)).text(),'private body');
});

test('Opaque redirects promptly cancel redirect bodies without exposing their headers',async()=>{
  let canceled=false;
  const raw=remember_response(new Response(new ReadableStream({cancel(){canceled=true;}}),{status:307,headers:{location:'/destination','x-private':'secret'}}),{url:'https://app.test/source'}),response=opaque_redirect_response(raw);
  await new Promise(setImmediate);assert.equal(canceled,true);assert.equal(response.body,null);assert.deepEqual([...response.headers],[]);
  assert.equal(response_metadata(response).internal_response.status,307);assert.deepEqual(response_metadata(response).internal_response.headers,[['location','/destination'],['x-private','secret']]);
});

test('Opaque snapshots do not consult authored header or Blob stream overrides',async()=>{
  const events=create_service_worker_events({responseMetadata:response_metadata}),raw=remember_response(new Response('private body',{status:302,headers:{'x-private':'secret'}}),{url:'https://app.test/source'});
  const get=Headers.prototype.get,each=Headers.prototype.forEach,stream=Blob.prototype.stream;
  try{
    Headers.prototype.get=Headers.prototype.forEach=()=>{throw new Error('Authored header override');};
    const response=opaque_redirect_response(raw);
    Blob.prototype.stream=()=>{throw new Error('Authored stream override');};
    const event=new events.FetchEvent('fetch',{request:new Request('https://app.test/navigation',{redirect:'manual'})}),result=events.dispatch_event(event,view=>view.respondWith(response)),handle=await result.response;
    assert.equal(handle.metadata.type,'opaqueredirect');assert.equal(handle.metadata.internal_response.status,302);
    const chunks=[];for(;;){const chunk=await handle.reader.read();if(chunk.done)break;chunks.push(...chunk.value);}
    assert.equal(new TextDecoder().decode(Uint8Array.from(chunks)),'private body');events.finish_fetch(event);
  }finally{Headers.prototype.get=get;Headers.prototype.forEach=each;Blob.prototype.stream=stream;}
});

test('Expiring a fetch event rejects while its filtered response snapshot is still pending',{timeout:1000},async()=>{
  let controller;const raw=remember_response(new Response(new ReadableStream({start(value){controller=value;}}),{status:302}),{url:'https://app.test/source'}),response=opaque_redirect_response(raw);
  const events=create_service_worker_events({responseMetadata:response_metadata}),event=new events.FetchEvent('fetch',{request:new Request('https://app.test/navigation',{redirect:'manual'})}),result=events.dispatch_event(event,view=>view.respondWith(response));
  await new Promise(setImmediate);const failure=assert.rejects(result.response,{name:'TimeoutError'});events.expire(event);await failure;
  controller.close();await new Promise(setImmediate);
});
