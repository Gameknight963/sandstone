import test from 'node:test';
import assert from 'node:assert/strict';
import {ServiceWorkerBridge} from '../src/service_worker/bridge.mjs';

function setup(options={}){
  const sent=[],state={terminated:0};
  const bridge=new ServiceWorkerBridge({post:(packet,ports)=>sent.push({packet,ports}),terminate:()=>state.terminated++,...options});
  return {bridge,sent,state};
}
test('Service worker bridge keeps body reads independent of response headers and event lifetime',async()=>{
  const {bridge,sent}=setup();
  try{
    bridge.accept({type:'ready'});await bridge.ready;
    const result=bridge.dispatch({id:7,event:'fetch',request:{url:'https://site.test/'}});
    bridge.accept({type:'lifetime',id:7});await bridge.wait(7);
    bridge.accept({type:'response',id:7,metadata:{status:200},body:true});assert.equal((await result).metadata.status,200);
    const read=bridge.read(7);assert.throws(()=>bridge.read(7),{name:'InvalidStateError'});
    bridge.accept({type:'chunk',id:7,value:Uint8Array.of(1,2),done:false});assert.deepEqual(await read,{done:false,value:Uint8Array.of(1,2)});
    const eof=bridge.read(7);bridge.accept({type:'chunk',id:7,done:true});assert.equal((await eof).done,true);
    bridge.handled(7);assert.equal(sent.at(-1).packet.type,'handled');bridge.release(7);assert.equal(bridge.jobs.size,0);
  }finally{bridge.close();}
});
test('Service worker bridge forwards ports and settles actual owner commands without dropping failures',async()=>{
  const {bridge,sent}=setup({command:async(method,args)=>{if(method==='failure')throw new DOMException('Denied','SecurityError');return args[0]+1;}});
  const channel=new MessageChannel();
  try{
    bridge.accept({type:'ready'});
    const result=bridge.dispatch({id:1,event:'message',ports:[channel.port1]});assert.equal(sent[0].ports[0],channel.port1);
    bridge.accept({type:'dispatched',id:1});bridge.accept({type:'lifetime',id:1});await result;await bridge.wait(1);bridge.release(1);
    bridge.accept({type:'command',id:20,method:'increment',args:[41]});
    bridge.accept({type:'command',id:21,method:'failure',args:[]});
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(sent.find(value=>value.packet.id===20).packet,{type:'command-result',id:20,value:42});
    assert.deepEqual(sent.find(value=>value.packet.id===21).packet.error,{name:'SecurityError',message:'Denied'});
  }finally{bridge.close();channel.port1.close();channel.port2.close();}
});
test('Service worker bridge reports read errors separately from successful background work',async()=>{
  const {bridge}=setup();
  try{
    bridge.accept({type:'ready'});
    const response=bridge.dispatch({id:1,event:'fetch'});bridge.accept({type:'response',id:1});await response;
    const read=bridge.read(1);bridge.accept({type:'error',id:1,error:{name:'TypeError',message:'Body failed'}});
    await assert.rejects(read,{name:'TypeError',message:'Body failed'});
    bridge.accept({type:'lifetime',id:1});await bridge.wait(1);
    const canceled=bridge.cancel(1,'done');bridge.accept({type:'canceled',id:1});await canceled;bridge.release(1);
  }finally{bridge.close();}
});
test('Closing a service worker bridge rejects pending startup, event and stream operations once',async()=>{
  const {bridge,state}=setup();
  const startup=assert.rejects(bridge.ready,{name:'AbortError'});
  const response=assert.rejects(bridge.dispatch({id:1,event:'fetch'}),{name:'AbortError'});
  const lifetime=assert.rejects(bridge.wait(1),{name:'AbortError'}),read=assert.rejects(bridge.read(1),{name:'AbortError'});
  bridge.close();bridge.close();await Promise.all([startup,response,lifetime,read]);assert.equal(state.terminated,1);assert.equal(bridge.jobs.size,0);
  assert.throws(()=>bridge.dispatch({id:2,event:'install'}),{name:'InvalidStateError'});
});
test('A stalled service worker operation times out and terminates its owner',async()=>{
  const {bridge,state}=setup({timeout:10});await assert.rejects(bridge.ready,{name:'TimeoutError'});assert.equal(state.terminated,1);
});
