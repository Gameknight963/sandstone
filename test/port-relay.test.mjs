import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {PortRelay,message_transfers} from '../src/host/port_relay.mjs';

const message=port=>new Promise(resolve=>port.addEventListener('message',resolve,{once:true}));
function fixture(t,options){
  const a=new MessageChannel(),b=new MessageChannel(),relay=new PortRelay(a.port2,b.port1,options);
  a.port1.start();b.port2.start();t.after(()=>{relay.close();a.port1.close();b.port2.close();});
  return {relay,first:a.port1,second:b.port2,internal:[a.port2,b.port1]};
}

test('Port forwarding preserves graph identity and transfers referenced and unreferenced ports',async t=>{
  const {first,second}=fixture(t),channel=new MessageChannel(),unreferenced=new MessageChannel(),view=new Uint8Array([1,2,3]);
  t.after(()=>{channel.port2.close();unreferenced.port2.close();});
  const graph={view,buffer:view.buffer,port:channel.port1,sparse:new Array(5),blob:new Blob([],{type:'application/x-key-capability'})};
  graph.self=graph;graph.map=new Map([[view.buffer,graph]]);graph.set=new Set([view]);graph.sparse[4]=view;
  const received=message(second);first.postMessage(graph,[view.buffer,channel.port1,unreferenced.port1]);assert.equal(view.byteLength,0);
  const event=await received,data=event.data;t.after(()=>event.ports.forEach(port=>port.close()));
  assert.equal(data.self,data);assert.equal(data.buffer,data.view.buffer);assert.equal(data.map.get(data.buffer),data);assert.equal([...data.set][0],data.view);
  assert.equal(data.sparse[4],data.view);assert.equal(0 in data.sparse,false);assert.deepEqual([...data.view],[1,2,3]);assert.equal(data.blob.type,'application/x-key-capability');
  assert.equal(event.ports.length,2);assert.equal(event.ports[0],data.port);
  channel.port2.start();unreferenced.port2.start();
  const a=message(channel.port2),b=message(unreferenced.port2);data.port.postMessage('referenced');event.ports[1].postMessage('unreferenced');
  assert.equal((await a).data,'referenced');assert.equal((await b).data,'unreferenced');
});

test('Transfer selection relays readable, writable and transform streams through native serialization',async()=>{
  const writes=[];let sinkClosed;const closed=new Promise(resolve=>{sinkClosed=resolve;});
  const data={readable:new ReadableStream({start(controller){controller.enqueue('source');controller.close();}}),writable:new WritableStream({write(value){writes.push(value);},close(){sinkClosed();}}),transform:new TransformStream()};
  // Node exposes internal stream ports in MessageEvent.ports; Chromium does
  // not. The browser fixture covers PortRelay's complete stream event path.
  const snapshot=structuredClone(data,{transfer:[data.readable,data.writable,data.transform]});
  const remote=structuredClone(snapshot,{transfer:message_transfers(snapshot)}),reader=remote.readable.getReader();
  assert.deepEqual(await reader.read(),{value:'source',done:false});assert.equal((await reader.read()).done,true);
  const writer=remote.writable.getWriter();await writer.write('sink');await writer.close();await closed;assert.deepEqual(writes,['sink']);
  const transformed=remote.transform.readable.getReader(),next=transformed.read(),output=remote.transform.writable.getWriter();
  await output.write('transform');assert.equal((await next).value,'transform');const ended=transformed.read();await output.close();assert.equal((await ended).done,true);
});

test('Port forwarding keeps both directions ordered and closure removes native listeners',async t=>{
  const {relay,first,second,internal}=fixture(t),forward=[],reverse=[];
  const a=new Promise(resolve=>{second.addEventListener('message',event=>{forward.push(event.data);if(forward.length===20)resolve();});});
  const b=new Promise(resolve=>{first.addEventListener('message',event=>{reverse.push(event.data);if(reverse.length===20)resolve();});});
  for(let index=0;index<20;index++){first.postMessage(index);second.postMessage(index);}
  await Promise.all([a,b]);assert.deepEqual(forward,[...Array(20).keys()]);assert.deepEqual(reverse,forward);
  relay.close();relay.close();
  for(const port of internal){assert.equal(getEventListeners(port,'message').length,0);assert.equal(getEventListeners(port,'messageerror').length,0);}
});

test('Native deserialization errors are reported without breaking later valid messages',async t=>{
  const errors=[],{first,second,internal}=fixture(t,{onError:(error,direction)=>errors.push({name:error.name,direction})});
  internal[0].dispatchEvent(new MessageEvent('messageerror'));assert.deepEqual(errors,[{name:'DataCloneError',direction:0}]);
  const received=message(second);first.postMessage('recovered');assert.equal((await received).data,'recovered');
});

test('Transfer selection walks error causes and binary subviews without changing the message',()=>{
  const buffer=new ArrayBuffer(4),view=new DataView(buffer,1,2),value=new Error('message',{cause:{view}});
  const transfers=message_transfers(value);assert.deepEqual(transfers,[buffer]);assert.equal(value.cause.view,view);assert.equal(buffer.byteLength,4);
  const pair=new MessageChannel();assert.throws(()=>new PortRelay(pair.port1,pair.port1),TypeError);pair.port1.close();pair.port2.close();
});
