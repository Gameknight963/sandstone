import test from 'node:test';
import assert from 'node:assert/strict';
import {create_service_worker_events} from '../src/service_worker/events.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const request=()=>new Request('https://site.test/asset');

test('Service worker event constructors preserve request and promise identity and reject synthetic lifetime extensions',async()=>{
  const api=create_service_worker_events(),req=request(),preload=Promise.resolve(new Response('preload')),handled=Promise.resolve();
  for(const operation of [()=>new api.ExtendableEvent(),()=>new api.FetchEvent('fetch'),()=>new api.FetchEvent('fetch',{}),()=>new api.FetchEvent('fetch',{request:{url:req.url}})])assert.throws(operation,TypeError);
  const event=new api.FetchEvent('fetch',{request:req,preloadResponse:preload,handled,clientId:42,replacesClientId:null,resultingClientId:'new'});
  assert.equal(event.request,req);assert.equal(event.preloadResponse,preload);assert.equal(event.handled,handled);
  assert.equal(event.clientId,'42');assert.equal(event.replacesClientId,'null');assert.equal(event.resultingClientId,'new');
  assert.equal(event.isTrusted,false);assert.ok(event instanceof Event);assert.ok(event instanceof api.ExtendableEvent);
  assert.equal(Object.prototype.toString.call(event),'[object FetchEvent]');
  assert.equal(Reflect.set(event,'request',request()),false);
  assert.throws(()=>event.waitUntil(),TypeError);assert.throws(()=>event.respondWith(),TypeError);
  assert.throws(()=>event.waitUntil(Promise.resolve()),{name:'InvalidStateError'});
  assert.throws(()=>event.respondWith(new Response('synthetic')),{name:'InvalidStateError'});
  assert.throws(()=>api.ExtendableEvent.prototype.waitUntil.call({},Promise.resolve()),TypeError);
  assert.throws(()=>Object.getOwnPropertyDescriptor(api.FetchEvent.prototype,'request').get.call(new api.ExtendableEvent('install')),TypeError);
  assert.throws(()=>api.FetchEvent.prototype.respondWith.call(new api.ExtendableEvent('install'),new Response('wrong brand')),TypeError);
  const target=new EventTarget();let rejected;
  target.addEventListener('fetch',()=>{try{event.respondWith(new Response('synthetic'));}catch(error){rejected=error.name;}});
  target.dispatchEvent(event);assert.equal(rejected,'InvalidStateError');
  assert.equal(await new api.FetchEvent('fetch',{request:req}).preloadResponse,undefined);
});

test('Trusted lifecycle dispatch ends when its lifetime promises settle, including microtask extensions',async()=>{
  const api=create_service_worker_events(),first=deferred(),second=deferred(),event=new api.ExtendableEvent('install'),seen=[];
  const result=api.dispatch_event(event,view=>{
    assert.equal(view.isTrusted,true);assert.equal(view.type,'install');assert.equal(view.waitUntil,view.waitUntil);
    view.waitUntil(first.promise);
    first.promise.then(()=>{seen.push('extended');view.waitUntil(second.promise);});
  });
  let completed=false;result.lifetime.then(()=>completed=true);first.resolve();await tick();
  assert.deepEqual(seen,['extended']);assert.equal(completed,false);
  second.resolve();await result.lifetime;assert.equal(completed,true);
  assert.throws(()=>result.event.waitUntil(Promise.resolve()),{name:'InvalidStateError'});
  assert.throws(()=>api.dispatch_event(event,()=>{}),{name:'InvalidStateError'});
});

test('Lifecycle rejection remains observable without ending unrelated pending work early',async()=>{
  const api=create_service_worker_events(),gate=deferred(),event=new api.ExtendableEvent('activate');
  const result=api.dispatch_event(event,view=>{view.waitUntil(Promise.reject(undefined));view.waitUntil(gate.promise);});
  let settled=false;const outcome=result.lifetime.then(()=>({fulfilled:true}),error=>({error})).then(value=>{settled=true;return value;});
  await tick();assert.equal(settled,false);gate.resolve();assert.deepEqual(await outcome,{error:undefined});
});

test('Fetch respondWith is synchronous, stops later listeners, and preserves callback object identity',async()=>{
  const api=create_service_worker_events(),target=new EventTarget(),event=new api.FetchEvent('fetch',{request:request(),cancelable:true}),seen=[];
  const listener={handleEvent(view){assert.equal(this,listener);assert.equal(view.target,target);assert.equal(view.currentTarget,target);assert.equal(view.isTrusted,true);seen.push('first');view.respondWith(new Response('answer'));assert.throws(()=>view.respondWith(new Response('second')),{name:'InvalidStateError'});}};
  assert.equal(api.wrap_listener(listener),api.wrap_listener(listener));
  target.addEventListener('fetch',api.wrap_listener(listener));target.addEventListener('fetch',()=>seen.push('second'));
  const result=api.dispatch_event(event,(_,raw)=>target.dispatchEvent(raw));
  assert.deepEqual(seen,['first']);assert.equal(result.responded,true);assert.equal(result.canceled,false);
  const handle=await result.response;assert.equal(new TextDecoder().decode((await handle.reader.read()).value),'answer');
  assert.equal((await handle.reader.read()).done,true);await result.lifetime;
  assert.throws(()=>result.event.respondWith(new Response('late')),{name:'InvalidStateError'});
  api.finish_fetch(event);await event.handled;
});

test('Pending waitUntil does not permit asynchronous respondWith, and canceled unhandled fetches remain distinct',async()=>{
  const api=create_service_worker_events(),gate=deferred(),event=new api.FetchEvent('fetch',{request:request(),cancelable:true});
  const result=api.dispatch_event(event,view=>{view.waitUntil(gate.promise);view.preventDefault();});
  assert.equal(result.response,null);assert.equal(result.responded,false);assert.equal(result.canceled,true);
  assert.throws(()=>result.event.respondWith(new Response('late')),{name:'InvalidStateError'});
  gate.resolve();await result.lifetime;
});

test('Fetch response delivery and background event lifetime finish independently',async()=>{
  const api=create_service_worker_events(),gate=deferred(),event=new api.FetchEvent('fetch',{request:request()});
  const result=api.dispatch_event(event,view=>{view.respondWith(new Response(null));view.waitUntil(gate.promise);});
  assert.equal((await result.response).reader,null);let ended=false;result.lifetime.then(()=>ended=true);
  api.finish_fetch(event);await event.handled;assert.equal(ended,false);
  gate.resolve();await result.lifetime;assert.equal(ended,true);
});

test('Invalid, used and locked responses reject instead of falling through to the network',async()=>{
  const used=new Response('used');await used.text();const locked=new Response('locked'),lock=locked.body.getReader();
  for(const value of [{body:'fake'},Response.error(),used,locked]){
    const api=create_service_worker_events(),event=new api.FetchEvent('fetch',{request:request()});
    const result=api.dispatch_event(event,view=>view.respondWith(value));
    await assert.rejects(result.response,TypeError);await result.lifetime;assert.equal(result.responded,true);
  }
  lock.releaseLock();
  const failure=new Error('failed response'),api=create_service_worker_events(),event=new api.FetchEvent('fetch',{request:request()});
  const result=api.dispatch_event(event,view=>view.respondWith(Promise.reject(failure)));
  await assert.rejects(result.response,error=>error===failure);await assert.rejects(result.lifetime,error=>error===failure);
  api.finish_fetch(event,failure);await assert.rejects(event.handled,error=>error===failure);
});

test('Response forwarding snapshots byte subviews, claims the original body and propagates cancellation',async()=>{
  const bytes=Uint8Array.from([9,1,2,3,9]),original=new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(1,4));controller.close();}}));
  const api=create_service_worker_events(),event=new api.FetchEvent('fetch',{request:request()}),result=api.dispatch_event(event,view=>view.respondWith(original));
  const handle=await result.response;assert.equal(original.body.locked,true);
  assert.deepEqual([...((await handle.reader.read()).value)],[1,2,3]);assert.deepEqual([...bytes],[9,1,2,3,9]);
  assert.equal((await handle.reader.read()).done,true);await result.lifetime;
  let canceled;const pending=new Response(new ReadableStream({cancel(reason){canceled=reason;}})),next=new api.FetchEvent('fetch',{request:request()});
  const response=await api.dispatch_event(next,view=>view.respondWith(pending)).response;
  await response.reader.cancel('client canceled');assert.equal(canceled,'client canceled');
});

test('Response streams keep backpressure and reject non-byte chunks without truncated success',async()=>{
  let pulls=0;const original=new Response(new ReadableStream({pull(controller){pulls++;controller.enqueue(Uint8Array.of(pulls));if(pulls===10)controller.close();}}));
  const api=create_service_worker_events(),event=new api.FetchEvent('fetch',{request:request()}),result=api.dispatch_event(event,view=>view.respondWith(original));
  const handle=await result.response;await tick();assert.ok(pulls<=2,'Response was eagerly drained');
  const values=[];for(;;){const part=await handle.reader.read();if(part.done)break;values.push(...part.value);}
  assert.deepEqual(values,[1,2,3,4,5,6,7,8,9,10]);
  const broken=new Response(new ReadableStream({start(controller){controller.enqueue('not bytes');}})),next=new api.FetchEvent('fetch',{request:request()});
  const bad=await api.dispatch_event(next,view=>view.respondWith(broken)).response;await assert.rejects(bad.reader.read(),TypeError);
});

test('Response metadata is frozen at claim time and synthetic Set-Cookie never reaches the client transport',async()=>{
  const original=new Response(null,{headers:{'X-Value':'before','Set-Cookie':'secret=value','Set-Cookie2':'other=value'}});
  Object.defineProperty(original,'type',{value:'opaque'});
  const api=create_service_worker_events(),event=new api.FetchEvent('fetch',{request:request()}),result=api.dispatch_event(event,view=>view.respondWith(original));
  const handle=await result.response;original.headers.set('X-Value','after');
  assert.equal(handle.metadata.headers.get('x-value'),'before');assert.equal(handle.metadata.headers.has('set-cookie'),false);assert.equal(handle.metadata.headers.has('set-cookie2'),false);
  assert.equal(original.headers.get('set-cookie'),'secret=value');assert.equal(handle.metadata.type,'default');
});

test('Worker expiry rejects pending responses and cannot be revived by late response promises',async()=>{
  const api=create_service_worker_events(),gate=deferred(),event=new api.FetchEvent('fetch',{request:request()}),result=api.dispatch_event(event,view=>view.respondWith(gate.promise));
  api.expire(event);await assert.rejects(result.response,{name:'TimeoutError'});await assert.rejects(result.lifetime,{name:'TimeoutError'});await assert.rejects(event.handled,{name:'TimeoutError'});
  const response=new Response('late');gate.resolve(response);await tick();assert.equal(response.bodyUsed,false);assert.equal(response.body.locked,false);
  assert.throws(()=>result.event.waitUntil(Promise.resolve()),{name:'InvalidStateError'});
});

test('Redispatching an authored event cannot reuse trusted lifetime privileges',async()=>{
  const api=create_service_worker_events(),gate=deferred(),event=new api.ExtendableEvent('message');
  const result=api.dispatch_event(event,view=>view.waitUntil(gate.promise));
  assert.equal(result.event.isTrusted,true);const raw=api.untrust(result.event);assert.equal(result.event.isTrusted,false);
  assert.throws(()=>api.view(raw).waitUntil(Promise.resolve()),{name:'InvalidStateError'});gate.resolve();await result.lifetime;
});

test('Legacy event initialization cannot change an active event or retain trust after reinitialization',async()=>{
  const api=create_service_worker_events(),gate=deferred(),event=new api.ExtendableEvent('message');
  const result=api.dispatch_event(event,view=>{view.waitUntil(gate.promise);view.initEvent('changed',true,true);assert.equal(view.type,'message');});
  result.event.initEvent('changed',true,true);assert.equal(result.event.type,'changed');assert.equal(result.event.isTrusted,false);
  assert.throws(()=>result.event.waitUntil(Promise.resolve()),{name:'InvalidStateError'});gate.resolve();await result.lifetime;
});

test('Response tainting obeys request mode and manual-redirect policy',async()=>{
  for(const [type,mode,redirect,allowed] of [['opaque','no-cors','follow',true],['opaque','cors','follow',false],['opaqueredirect','cors','manual',true],['opaqueredirect','cors','follow',false],['cors','cors','follow',true],['cors','same-origin','follow',false]]){
    const api=create_service_worker_events({responseMetadata:response=>({status:response.status,statusText:response.statusText,headers:response.headers,url:response.url,type,redirected:false})});
    const event=new api.FetchEvent('fetch',{request:new Request('https://site.test/',{mode,redirect})}),result=api.dispatch_event(event,view=>view.respondWith(new Response(null)));
    if(allowed)assert.equal((await result.response).metadata.type,type);else await assert.rejects(result.response,TypeError);
    await result.lifetime;
  }
});

test('Extendable messages retain data, validate ports and source brands, and keep frozen port lists',async()=>{
  const api=create_service_worker_events(),channel=new MessageChannel(),data={cache:['https://site.test/']};
  try{
    const event=new api.ExtendableMessageEvent('message',{data,origin:'https://site.test/\uD800',lastEventId:7,ports:new Set([channel.port1]),source:channel.port2});
    assert.equal(event.data,data);assert.equal(event.origin,'https://site.test/\uFFFD');assert.equal(event.lastEventId,'7');assert.equal(event.source,channel.port2);
    assert.deepEqual(event.ports,[channel.port1]);assert.equal(Object.isFrozen(event.ports),true);
    assert.equal(new api.ExtendableMessageEvent('message').data,null);
    for(const init of [{ports:null},{ports:[{}]},{ports:{0:channel.port1,length:1}},{source:{}},{origin:Symbol('origin')}])assert.throws(()=>new api.ExtendableMessageEvent('message',init),TypeError);
    assert.throws(()=>Object.getOwnPropertyDescriptor(api.ExtendableMessageEvent.prototype,'data').get.call(new api.ExtendableEvent('install')),TypeError);
    const gate=deferred(),result=api.dispatch_event(event,view=>{assert.equal(view.data,data);view.waitUntil(gate.promise);});
    gate.resolve();await result.lifetime;
  }finally{channel.port1.close();channel.port2.close();}
});

test('Event internals do not invoke authored overrides of Promise resolve or native promise then',async()=>{
  const api=create_service_worker_events(),event=new api.FetchEvent('fetch',{request:request()}),response=Promise.resolve(new Response(null)),lifetime=Promise.resolve();
  for(const value of [response,lifetime])Object.defineProperty(value,'then',{value(){throw new Error('Authored then override');}});
  const original=Promise.resolve;let result;
  try{
    Promise.resolve=()=>{throw new Error('Authored resolve override');};
    result=api.dispatch_event(event,view=>{view.waitUntil(lifetime);view.respondWith(response);});
  }finally{Promise.resolve=original;}
  assert.equal((await result.response).reader,null);await result.lifetime;
});

test('A source body failure becomes a fetch TypeError rather than exposing its arbitrary rejection value',async()=>{
  const api=create_service_worker_events(),event=new api.FetchEvent('fetch',{request:request()}),source=new Response(new ReadableStream({start(controller){controller.error('private source failure');}}));
  const handle=await api.dispatch_event(event,view=>view.respondWith(source)).response;
  await assert.rejects(handle.reader.read(),TypeError);
});
