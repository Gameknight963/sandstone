import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.self=globalThis;
globalThis.parent=globalThis;
const rpc=await import('../src/rpc.mjs');
delete globalThis.self;delete globalThis.parent;

test('Retired frame ports drain only allowed unload calls and expire independently of replacements',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  class Port extends EventTarget{
    closed=false;
    close(){this.closed=true;}
    emit(data){this.dispatchEvent(new MessageEvent('message',{data}));}
  }
  const target=new rpc.RPCTarget(),old=new Port(),replacement=new Port(),messages=[],outgoing=[],controller=new AbortController();
  target.onmessage=event=>messages.push(event.data);
  target.add_extra_target(old,'frame');target.retire_extra_target('frame',{procedures:['beacon'],timeout:100});
  assert.equal(target.extra_frame_targets.size,0);assert.equal(target.extra_targets.length,0);
  assert.equal(target.retired_targets.size,1);
  target.add_extra_target(replacement,'frame');
  const pending=['beacon','fetch'].map(procedure=>rpc.call_procedure({postMessage(message){outgoing.push(message);old.emit(message);}},procedure,[],{signal:controller.signal}).catch(error=>error));
  old.emit({type:'notification',procedure:'beacon'});old.emit(null);old.emit({type:'reply',id:'pending'});
  assert.deepEqual(messages,[outgoing[0],{type:'reply',id:'pending'}]);
  controller.abort();await Promise.all(pending);
  t.mock.timers.tick(100);
  assert.equal(old.closed,true);assert.equal(target.retired_targets.size,0);assert.equal(replacement.closed,false);
  old.emit(outgoing[0]);replacement.emit(outgoing[1]);
  assert.equal(messages.length,3);assert.equal(messages[2].procedure,'fetch');
});

test('RPC notifications deliver updates without allocating requests or sending replies',async()=>{
  const values=[],messages=[];
  rpc.rpc_handlers.test_notification=value=>values.push(value);
  try{
    rpc.notify({postMessage:message=>messages.push(message)},'test_notification',[42]);
    await rpc.message_listener({data:messages[0],source:{postMessage(){throw new Error('Notification sent a reply');}}});
    assert.deepEqual(values,[42]);assert.deepEqual(Object.keys(rpc.rpc_requests),[]);
  }finally{delete rpc.rpc_handlers.test_notification;}
});

test('RPC cancellation removes pending replies and ignores late replies',async()=>{
  const controller=new AbortController(),messages=[];
  const request=rpc.call_procedure({postMessage:message=>messages.push(message)},'pending',[],{signal:controller.signal});
  assert.equal(messages.length,1);
  assert.equal(Object.keys(rpc.rpc_requests).length,1);
  controller.abort();
  await assert.rejects(request,{name:'AbortError'});
  assert.deepEqual(Object.keys(rpc.rpc_requests),[]);
  await rpc.message_listener({data:{type:'reply',id:messages[0].id,content:{success:true,value:'late'}}});
  assert.deepEqual(Object.keys(rpc.rpc_requests),[]);
});

test('RPC abort before sending, normal replies and transport errors all clean up',async()=>{
  const controller=new AbortController();controller.abort(new Error('superseded'));
  let sent=false;
  await assert.rejects(rpc.call_procedure({postMessage(){sent=true;}},'unused',[],{signal:controller.signal}),/superseded/);
  assert.equal(sent,false);
  const successful=rpc.call_procedure({postMessage(message){
    queueMicrotask(()=>rpc.message_listener({data:{type:'reply',id:message.id,content:{success:true,value:42}}}));
  }},'success',[]);
  assert.equal(await successful,42);
  await assert.rejects(rpc.call_procedure({postMessage(){throw new DOMException('Cannot clone','DataCloneError');}},'failure',[]),{name:'DataCloneError'});
  assert.deepEqual(Object.keys(rpc.rpc_requests),[]);
});

function window_events(t){
  const events=new EventTarget(),previous=new Map();let listeners=0;
  for(const name of ['addEventListener','removeEventListener']){
    previous.set(name,Object.getOwnPropertyDescriptor(globalThis,name));
    globalThis[name]=(...args)=>{if(args[0]==='message')listeners+=name==='addEventListener'?1:-1;return events[name](...args);};
  }
  t.after(()=>{for(const [name,descriptor] of previous)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];});
  return {listeners:()=>listeners,emit(data,source){const event=new Event('message');Object.defineProperties(event,{data:{value:data},source:{value:source}});events.dispatchEvent(event);}};
}

test('Frame readiness requires the request nonce, source Window and intended document URL',async t=>{
  const events=window_events(t),messages=[],target={postMessage:message=>messages.push(message)};
  const frame={src:'blob:runtime#new-document',contentWindow:target};
  let resolved=false;
  const waiting=rpc.wait_on_frame(frame).then(()=>{resolved=true;});
  const ping=messages[0];
  events.emit(null,target);
  events.emit({type:'pong',id:ping.id,url:'blob:runtime#old-document'},target);
  events.emit({type:'pong',id:'old-request',url:ping.url},target);
  events.emit({type:'pong',id:ping.id,url:ping.url},{});
  await Promise.resolve();assert.equal(resolved,false);
  events.emit({type:'pong',id:ping.id,url:ping.url},target);
  await waiting;assert.equal(events.listeners(),0);
  await new Promise(resolve=>setTimeout(resolve,65));assert.equal(messages.length,1);
});

test('Superseded frame readiness waits remove listeners and stop polling',async t=>{
  const events=window_events(t),controller=new AbortController();let sent=0;
  const waiting=rpc.wait_on_frame({src:'blob:runtime',contentWindow:{postMessage(){sent++;}}},{signal:controller.signal});
  controller.abort();await assert.rejects(waiting,{name:'AbortError'});
  assert.equal(events.listeners(),0);
  await new Promise(resolve=>setTimeout(resolve,65));assert.equal(sent,1);
});

test('Child readiness uses the physical runtime URL instead of a reflected virtual src',async t=>{
  const events=window_events(t),messages=[],target={postMessage:message=>messages.push(message)};
  const frame={src:'https://fixture.test/authored-child',contentWindow:target};
  let resolved=false;
  const waiting=rpc.wait_on_frame(frame,{url:'blob:child-runtime'}).then(()=>{resolved=true;});
  const ping=messages[0];
  assert.equal(ping.url,'blob:child-runtime');
  events.emit({type:'pong',id:ping.id,url:frame.src},target);
  await Promise.resolve();assert.equal(resolved,false);
  events.emit({type:'pong',id:ping.id,url:ping.url},target);
  await waiting;assert.equal(events.listeners(),0);
});
