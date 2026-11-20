import test from 'node:test';
import assert from 'node:assert/strict';
import {ServiceWorkerFetch} from '../src/service_worker/fetch.mjs';

const context={url:'https://app.test/page',top_url:'https://app.test/page'};
function environment(handler=()=>({type:'response',metadata:{status:200,headers:[]},body:true})){
  const events=[],jobs=[],networks=[];
  const client={id:'client',controller:{state:'activated'},registration:{}};
  const manager={async dispatch(record,worker,event,options){
    events.push(event);assert.equal(options.waitHandled,true);
    const job={handledCalls:[],canceled:[],aborts:[],reads:0,
      result:Promise.resolve().then(()=>handler(event)),lifetime:Promise.resolve(),
      async read(){return ++this.reads===1?{done:false,value:Uint8Array.of(65,66)}:{done:true};},
      async handled(error){this.handledCalls.push(error);},async cancel(reason){this.canceled.push(reason);},async abort(reason){this.aborts.push(reason);}};
    jobs.push(job);return job;
  }};
  const router=new ServiceWorkerFetch({manager,client:()=>client});
  const network=async(url,options)=>{networks.push({url,options});return new Response('network');};
  return {router,client,events,jobs,networks,network,fetch:(url='https://app.test/data',options={},ctx=context)=>router.fetch(url,options,ctx,network)};
}
test('Controlled fetches stream worker responses without entering the HTTP pipeline',async()=>{
  const api=environment(),response=await api.fetch();
  assert.equal(response.url,'https://app.test/data');assert.equal(api.jobs[0].reads,0);
  assert.equal(await response.text(),'AB');assert.equal(api.jobs[0].reads,2);
  assert.deepEqual(api.jobs[0].handledCalls,[undefined]);assert.equal(api.networks.length,0);
});
test('Worker requests expose virtual context without transport cookies or security headers',async()=>{
  const api=environment();const response=await api.fetch(undefined,{method:'POST',body:Uint8Array.of(7),mode:'cors',destination:'image',referrerPolicy:'origin',headers:{cookie:'secret',origin:'https://forged.test',referer:'https://forged.test',host:'wrong','sec-fetch-site':'same-origin',authorization:'token','x-authored':'yes'}});
  const event=api.events[0];assert.equal(event.clientId,'client');
  assert.deepEqual(event.request.headers,[['authorization','token'],['x-authored','yes']]);
  assert.equal(event.request.virtualReferrer,'https://app.test/');assert.equal(event.request.destination,'image');
  assert.equal(event.request.body[0],7);await response.body.cancel();
});
test('Uncontrolled, navigation and bypass requests use the network without dispatching',async()=>{
  const api=environment();
  for(const flags of [{navigation:true},{service_worker_bypass:true}])assert.equal(await (await api.fetch(undefined,{},flags)).text(),'network');
  api.client.controller=null;assert.equal(await (await api.fetch()).text(),'network');
  assert.equal(api.events.length,0);assert.equal(api.networks.length,3);
});
test('An unhandled fetch falls through once, while worker rejection remains a network error',async()=>{
  const api=environment(()=>({type:'fallback'}));assert.equal(await (await api.fetch()).text(),'network');
  assert.equal(api.networks.length,1);assert.deepEqual(api.jobs[0].handledCalls,[undefined]);
  const broken=environment(()=>{throw new TypeError('Rejected respondWith');});
  await assert.rejects(broken.fetch(),/Rejected respondWith/);assert.equal(broken.networks.length,0);
});
test('Synthetic responses cannot set cookies and HEAD cancels rather than reading a body',async()=>{
  const api=environment(()=>({type:'response',metadata:{status:200,headers:[['set-cookie','secret=value'],['x-result','ok']]},body:true}));
  const response=await api.fetch(undefined,{method:'HEAD'});
  assert.equal(response.body,null);assert.equal(response.headers.has('set-cookie'),false);assert.equal(response.headers.get('x-result'),'ok');
  assert.equal(api.jobs[0].reads,0);assert.equal(api.jobs[0].canceled.length,1);
});
test('Abort rejects before response headers and forwards abort/cancel to the worker',async()=>{
  let resolve;const api=environment(()=>new Promise(yes=>resolve=yes)),controller=new AbortController();
  const pending=api.fetch(undefined,{signal:controller.signal});
  await new Promise(setImmediate);controller.abort();
  await assert.rejects(pending,{name:'AbortError'});await new Promise(setImmediate);
  assert.equal(api.jobs[0].aborts.length,1);assert.equal(api.jobs[0].canceled.length>=1,true);
  resolve({type:'fallback'});await new Promise(setImmediate);assert.equal(api.networks.length,0);
});
test('Abort after headers errors body readers and cancels the worker stream',async()=>{
  const api=environment(),controller=new AbortController();const response=await api.fetch(undefined,{signal:controller.signal});
  const reader=response.body.getReader();assert.equal((await reader.read()).done,false);controller.abort();
  await assert.rejects(reader.read(),{name:'AbortError'});await new Promise(setImmediate);assert.equal(api.jobs[0].aborts.length,1);
});
test('Synthetic redirects re-enter workers, convert POST and strip credentials across origins',async()=>{
  const api=environment(event=>event.request.url==='https://app.test/data'?{type:'response',metadata:{status:302,headers:[['location','https://other.test/result']]},body:false}:{type:'fallback'});
  const response=await api.fetch(undefined,{method:'POST',body:'form',headers:{authorization:'secret','content-type':'text/plain'}});
  assert.equal(response.redirected,true);assert.equal(await response.text(),'network');
  assert.equal(api.events.length,2);const next=api.events[1].request;
  assert.equal(next.method,'GET');assert.equal(next.body,undefined);assert.deepEqual(next.headers,[]);
});
test('Manual and disallowed redirects never issue a destination request',async()=>{
  const api=environment(()=>({type:'response',metadata:{status:302,headers:[['location','/next']]},body:true}));
  const manual=await api.fetch(undefined,{redirect:'manual'});
  assert.equal(manual.type,'opaqueredirect');assert.equal(manual.status,0);assert.equal(manual.body,null);
  await assert.rejects(api.fetch(undefined,{redirect:'error'}),/Redirect disallowed/);assert.equal(api.networks.length,0);
});
