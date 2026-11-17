import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.self=globalThis;
globalThis.parent=globalThis;
const rpc=await import('../src/rpc.mjs');
delete globalThis.self;delete globalThis.parent;

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
