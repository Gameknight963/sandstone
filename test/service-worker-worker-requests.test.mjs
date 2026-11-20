import test from 'node:test';
import assert from 'node:assert/strict';
import {ServiceWorkerWorkerRequests} from '../src/service_worker/worker_requests.mjs';
import {fetch_with_cookies} from '../src/host/request.mjs';
import {SiteDataStore} from '../src/host/site_data.mjs';

function environment({route,transport,timeout=1000}={}){
  const frames={parent:{id:'parent',root_id:'parent',url:new URL('https://app.test/app/page'),origin:'https://app.test',broadcast_origin:'https://app.test',document_context:'creator'}},clients=new Map(),records=[],events=[],requests=[];let sequence=0;
  const manager={clients,list:async()=>records,addClient(value){const client={...value,registration:null,controller:null};clients.set(client.id,client);return client;},removeClient:id=>clients.delete(id),control:(client,record,worker)=>Object.assign(client,{registration:record,controller:worker}),requestActivation(){},collect(){}};
  const entries=new ServiceWorkerWorkerRequests({manager,frames:()=>frames,id:()=>String(++sequence),timeout,route:async(url,options,context,fallback)=>{events.push({url,options,context});return route?route(url,options,context):fallback();}});
  const data=new SiteDataStore(),context={frame_id:'parent',worker_entry_target:'child',url:frames.parent.url.href,top_url:frames.parent.url.href};
  const network=(url,options,context,worker)=>fetch_with_cookies(async(url,options)=>{requests.push({url,options});return transport?transport(url,options):new Response('network');},data,url,options,context,worker);
  const fetch=(url='https://app.test/app/entry.js',options={},ctx=context)=>entries.fetch(url,{mode:'same-origin',destination:'worker',...options},ctx,network);
  const frame=url=>frames.child={id:'child',parent_id:'parent',root_id:'parent',worker:true,origin:'https://app.test',url:new URL(url)};
  const close=()=>{for(const lease of [...entries.pending.values()])lease.release();};
  return {manager,entries,frames,frame,records,events,requests,fetch,context,close};
}

test('Worker entries reserve a distinct client until authenticated installation and retain the selected controller',async()=>{
  const api=environment({route:()=>new Response('cached')});const record={scope:'https://app.test/app/',active:{id:'active'}};api.records.push(record);
  try{
    const response=await api.fetch();assert.equal(await response.text(),'cached');assert.equal(api.requests.length,0);
    const token=api.entries.response(response),client=api.manager.clients.get(token);assert.equal(client.reserved,true);assert.equal(api.entries.reserved(token),true);
    assert.equal(api.events[0].context.service_worker_entry_parent,'creator');assert.equal(api.events[0].context.service_worker_entry,client);assert.equal(api.events[0].options.mode,'same-origin');assert.equal(api.events[0].options.destination,'worker');
    const selected=record.active;record.active={id:'replacement'};
    assert.equal(api.entries.commit(api.frame(response.url),token),token);assert.equal(client.reserved,false);assert.equal(client.controller,selected);assert.equal(client.worker_committed,true);assert.equal(api.entries.pending.size,0);
  }finally{api.close();}
});

test('Out-of-scope worker entries bypass the creator controller',async()=>{
  const api=environment();api.records.push({scope:'https://app.test/app/',active:{id:'active'}});
  try{const response=await api.fetch('https://app.test/outside.js');assert.equal(await response.text(),'network');assert.equal(api.events.length,0);assert.equal(api.requests.length,1);assert.equal(api.manager.clients.get(api.entries.response(response)).controller,null);}finally{api.close();}
});

test('Entry redirects select their destination controller without becoming document navigations',async()=>{
  const api=environment({transport:()=>new Response(null,{status:302,headers:{location:'/app/final.js'}}),route:()=>new Response('final')});api.records.push({scope:'https://app.test/app/',active:{id:'active'}});
  try{const response=await api.fetch('https://app.test/outside.js');assert.equal(await response.text(),'final');assert.equal(response.url,'https://app.test/app/final.js');assert.equal(response.redirected,true);assert.equal(api.events[0].context.navigation,undefined);assert.equal(api.entries.commit(api.frame(response.url),api.entries.response(response)),api.entries.response(response));}finally{api.close();}
});

test('Aborted lookups release clients immediately and late storage replies cannot resurrect them',async()=>{
  const api=environment(),controller=new AbortController();let release;api.manager.list=()=>new Promise(resolve=>release=resolve);
  const pending=api.fetch(undefined,{signal:controller.signal});controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(api.manager.clients.size,0);
  release([]);await new Promise(setImmediate);assert.equal(api.requests.length,0);assert.equal(api.manager.clients.size,0);
});

test('Body cancellation and failure release reservations rather than retaining partial scripts',async()=>{
  for(const fail of [false,true]){
    const api=environment({transport:()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]));if(fail)controller.error(new Error('broken'));}}))});
    const response=await api.fetch();if(fail)await assert.rejects(response.text(),/broken/);else await response.body.cancel();assert.equal(api.manager.clients.size,0);assert.equal(api.entries.pending.size,0);
  }
});

test('Canceled, expired, or superseded worker entries cannot be committed by another document',async()=>{
  const api=environment({timeout:10});
  try{
    const response=await api.fetch();await response.text();const token=api.entries.response(response);
    api.entries.cancel('foreign','child','creator');assert.equal(api.entries.pending.size,1);
    api.frames.parent.document_context='replacement';assert.throws(()=>api.entries.commit(api.frame(response.url),token),{name:'AbortError'});
    assert.equal(api.manager.clients.size,0);
    api.entries.disconnect('parent');assert.equal(api.manager.clients.size,0);delete api.frames.child;
    const expired=await api.fetch();await expired.text();await new Promise(resolve=>setTimeout(resolve,25));assert.equal(api.manager.clients.size,0);assert.throws(()=>api.entries.commit(api.frame(expired.url),api.entries.response(expired)),{name:'AbortError'});
  }finally{api.close();}
});
