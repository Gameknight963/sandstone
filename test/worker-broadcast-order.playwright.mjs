import assert from 'node:assert/strict';
import {wait_for} from './wait-for.mjs';

async function hold_registrations(page,name){
  await page.evaluate(name=>{
    const target=main_frame.rpc_target,original=target.onmessage,held=[];
    globalThis.broadcastOrder={held,restore(){target.onmessage=original;for(const release of held.splice(0))release();}};
    target.onmessage=function(event,...args){
      if(event.data?.procedure==='broadcast_open'&&event.data.arguments[2].startsWith(name)){
        const saved={data:event.data,source:event.source,currentTarget:event.currentTarget,ports:event.ports};held.push(()=>original(saved,...args));return;
      }
      return original(event,...args);
    };
  },name);
}

export async function verifyWorkerBroadcastOrder(page){
  for(const type of ['classic','module']){
    const name='worker-registration-'+type;
    await page.evaluate(async name=>{
      const url='https://fixture.test/broadcast-order';main_frame.special_pages[url]='<!doctype html><body>Worker registration ordering';await main_frame.navigate_to(url);
      await main_frame.eval_js('globalThis.channel=new BroadcastChannel('+JSON.stringify(name)+');true');
    },name);
    await page.waitForFunction(name=>[...sandstone.network.broadcast_channels.channels].some(entry=>JSON.parse(entry.key)[3]===name),name);
    await hold_registrations(page,name);
    try{
      const source=`const first=new BroadcastChannel(${JSON.stringify(name)}),second=new BroadcastChannel(${JSON.stringify(name+'-extra')});
        first.onmessage=event=>postMessage({kind:'broadcast',value:event.data});
        const ports=new MessageChannel();ports.port1.onmessage=event=>ports.port1.postMessage('echo:'+event.data);
        const payload={kind:'ready',bytes:new Uint8Array([1,2,3]),port:ports.port2};
        postMessage(payload,[payload.bytes.buffer,ports.port2]);payload.kind='changed';
        postMessage({kind:'after',detached:payload.bytes.byteLength===0});`;
      await page.evaluate(({source,type})=>main_frame.eval_js(`globalThis.messages=[];globalThis.portMessages=[];
        globalThis.workerURL=URL.createObjectURL(new Blob([${JSON.stringify(source)}],{type:'text/javascript'}));
        globalThis.worker=new Worker(workerURL,{type:${JSON.stringify(type)}});
        worker.onmessage=event=>{
          const data=event.data;
          if(data.kind==='ready'){messages.push({kind:data.kind,bytes:Array.from(data.bytes)});data.port.onmessage=event=>portMessages.push(event.data);data.port.postMessage('roundtrip');}
          else messages.push(data);
        };true`),{source,type});
      await page.waitForFunction(()=>broadcastOrder.held.length===2);
      assert.equal(await page.evaluate(()=>main_frame.eval_js('messages.length')),0,'Worker messages overtook pending BroadcastChannel registration');
      await page.evaluate(()=>broadcastOrder.held.shift()());
      assert.equal(await page.evaluate(()=>main_frame.eval_js('messages.length')),0,'One remaining registration did not hold worker messages');
      await page.evaluate(()=>broadcastOrder.held.shift()());
      await wait_for(async()=>await page.evaluate(()=>main_frame.eval_js('messages.length===2&&portMessages.length===1')));
      const delivered=JSON.parse(await page.evaluate(()=>main_frame.eval_js('JSON.stringify({messages,ports:portMessages})')));
      assert.deepEqual(delivered,{messages:[{kind:'ready',bytes:[1,2,3]},{kind:'after',detached:true}],ports:['echo:roundtrip']});
      await page.evaluate(()=>main_frame.eval_js('channel.postMessage("after readiness");true'));
      await wait_for(async()=>await page.evaluate(()=>main_frame.eval_js('messages.length===3')));
      assert.equal(await page.evaluate(()=>main_frame.eval_js('messages[2].value')),'after readiness');
      await page.evaluate(()=>main_frame.eval_js('worker.terminate();channel.close();URL.revokeObjectURL(workerURL);true'));
    }finally{await page.evaluate(()=>broadcastOrder.restore());}
  }
  for(const exit of ['close','error']){
    const name='worker-exit-'+exit;await hold_registrations(page,name);
    try{
      const source='new BroadcastChannel('+JSON.stringify(name)+');'+(exit==='close'?
        'onmessage=()=>{postMessage("before close");close();};':
        'await new Promise(resolve=>onmessage=resolve);postMessage("before error");throw new Error("forced worker exit");');
      await page.evaluate(({source,type})=>main_frame.eval_js(`globalThis.exitEvents=[];
        globalThis.workerURL=URL.createObjectURL(new Blob([${JSON.stringify(source)}],{type:'text/javascript'}));
        globalThis.worker=new Worker(workerURL,{type:${JSON.stringify(type)}});
        worker.onmessage=event=>exitEvents.push(event.data);worker.onerror=event=>{event.preventDefault();exitEvents.push('error');};true`),{source,type:exit==='close'?'classic':'module'});
      await page.waitForFunction(()=>broadcastOrder.held.length===1);
      await page.evaluate(()=>main_frame.eval_js('worker.postMessage("finish");true'));
      await wait_for(async()=>await page.evaluate(count=>main_frame.eval_js('exitEvents.length==='+count),exit==='close'?1:2));
      assert.deepEqual(JSON.parse(await page.evaluate(()=>main_frame.eval_js('JSON.stringify(exitEvents)'))),exit==='close'?['before close']:['before error','error']);
      await page.evaluate(()=>main_frame.eval_js('worker.terminate();URL.revokeObjectURL(workerURL);true'));
    }finally{await page.evaluate(()=>broadcastOrder.restore());}
  }
  return ['Classic/module worker readiness follows every pending BroadcastChannel registration','Held worker messages retain FIFO, synchronous snapshots, buffer detachment and MessagePort transfers','Worker close and startup failure deliver earlier messages without waiting for registrations'];
}
