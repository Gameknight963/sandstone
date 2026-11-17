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
