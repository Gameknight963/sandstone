import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {ActorInbox} from '../src/shared_worker/inbox.mjs';

const hello={sandstone_actor:'private',type:'hello',instance:'0123456789abcdef0123456789abcdef',phase:'ready'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('Native actor greetings are consumed while early authored packets retain FIFO and transfers across handoff',async()=>{
  const actor=new MessageChannel(),client=new MessageChannel(),nested=new MessageChannel(),inbox=new ActorInbox(actor.port1,'private');let relay;
  try{
    actor.port2.postMessage(hello);actor.port2.postMessage({index:1,bytes:new Uint8Array([1,2]),port:nested.port2},[nested.port2]);actor.port2.postMessage({index:2});
    assert.deepEqual(await inbox.ready,{instance:hello.instance,phase:'ready'});
    while(inbox.queue.length!==2)await tick();
    const received=[];client.port2.onmessage=event=>received.push(event.data);
    relay=inbox.bridge(client.port1);actor.port2.postMessage({index:3});
    while(received.length!==3)await tick();assert.deepEqual(received.map(value=>value.index),[1,2,3]);assert.deepEqual([...received[0].bytes],[1,2]);
    const echoed=once(nested.port1,'message');received[0].port.postMessage('transferred');assert.equal((await echoed)[0],'transferred');received[0].port.close();
    const inbound=once(actor.port2,'message');client.port2.postMessage('client');assert.equal((await inbound)[0],'client');
  }finally{relay?.close();inbox.close();actor.port2.close();client.port2.close();nested.port1.close();}
});

test('Hello-shaped authored messages remain ordinary user data after the first greeting',async()=>{
  const actor=new MessageChannel(),client=new MessageChannel(),inbox=new ActorInbox(actor.port1,'private');let relay;
  try{actor.port2.postMessage(hello);await inbox.ready;actor.port2.postMessage(hello);while(!inbox.queue.length)await tick();const received=once(client.port2,'message');relay=inbox.bridge(client.port1);assert.deepEqual((await received)[0],hello);}
  finally{relay?.close();inbox.close();actor.port2.close();client.port2.close();}
});

test('Invalid actor greetings and retirement reject readiness instead of authorizing a client port',async()=>{
  const actor=new MessageChannel(),inbox=new ActorInbox(actor.port1,'private');
  try{actor.port2.postMessage({...hello,sandstone_actor:'wrong'});await assert.rejects(inbox.ready,{name:'SecurityError'});assert.equal(inbox.closed,true);}
  finally{inbox.close();actor.port2.close();}
  const waiting=new MessageChannel(),controller=new AbortController(),reason={retired:true},pending=new ActorInbox(waiting.port1,'private',{signal:controller.signal});
  try{controller.abort(reason);await assert.rejects(pending.ready,error=>error===reason);assert.throws(()=>pending.bridge(waiting.port2),{name:'InvalidStateError'});}
  finally{pending.close();waiting.port2.close();}
});

test('Retirement closes transferred ports buffered before a client was bound',async()=>{
  const actor=new MessageChannel(),nested=new MessageChannel(),inbox=new ActorInbox(actor.port1,'private');
  try{actor.port2.postMessage(hello);await inbox.ready;actor.port2.postMessage('unused port',[nested.port2]);while(!inbox.queue.length)await tick();const closed=once(nested.port1,'close');inbox.close();await closed;}
  finally{inbox.close();actor.port2.close();nested.port1.close();}
});
