import test from 'node:test';
import assert from 'node:assert/strict';
import {remember_response,response_metadata} from '../src/response_metadata.mjs';
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
  const result=events.dispatch_event(event,view=>view.respondWith(response));
  await assert.rejects(result.response,TypeError);
});
