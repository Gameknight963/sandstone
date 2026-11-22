import assert from 'node:assert/strict';
export async function verify_actor_inbox(browser,origin){
  const context=await browser.newContext(),deadline=setTimeout(()=>context.close().catch(()=>{}),45000),page=await context.newPage();
  try{
    await page.goto(origin+'/host-worker/page');
    const result=await page.evaluate(async()=>{
      const {ActorInbox}=await import('/host-worker/src/shared_worker/inbox.mjs');
      const source=`onconnect=event=>{
        const port=event.ports[0],child=new MessageChannel(),orphan=new MessageChannel();
        child.port1.onmessage=event=>child.port1.postMessage(event.data);orphan.port1.onmessage=event=>orphan.port1.postMessage(event.data);
        port.postMessage({sandstone_actor:'native-inbox',type:'hello',instance:'0123456789abcdef0123456789abcdef',phase:'ready'});
        const bytes=new Uint8Array([3,4,5]),stream=new ReadableStream({start(controller){controller.enqueue('buffered stream');controller.close();}});
        port.postMessage({index:1,bytes,alias:bytes.buffer,port:child.port2,stream},[bytes.buffer,child.port2,orphan.port2,stream]);port.postMessage({index:2});
        port.onmessage=event=>port.postMessage({index:3,value:event.data});port.start();
      };`;
      const worker=new SharedWorker('data:text/javascript,'+encodeURIComponent(source),{name:'native-inbox'}),inbox=new ActorInbox(worker.port,'native-inbox');
      globalThis.nativeInbox={worker,inbox};await inbox.ready;return inbox.hello;
    });
    assert.equal(result.phase,'ready');await page.waitForFunction(()=>nativeInbox.inbox.queue.length===2);
    const received=await page.evaluate(async()=>{
      const client=new MessageChannel(),values=[];
      client.port2.onmessage=event=>{values.push(event);};const relay=nativeInbox.inbox.bridge(client.port1);client.port2.postMessage('client');
      await new Promise(resolve=>{const poll=()=>values.length===3?resolve():setTimeout(poll,0);poll();});
      const first=values[0],stream=await first.data.stream.getReader().read();
      const exchange=port=>new Promise(resolve=>{port.onmessage=event=>resolve(event.data);port.postMessage('roundtrip');});
      const ports=await Promise.all(first.ports.map(exchange));
      const result={order:values.map(event=>event.data.index),bytes:[...first.data.bytes],alias:first.data.alias===first.data.bytes.buffer,stream:stream.value,ports,trusted:values.every(event=>event.isTrusted),reply:values[2].data.value};
      for(const port of first.ports)port.close();relay.close();client.port2.close();return result;
    });
    assert.deepEqual(received,{order:[1,2,3],bytes:[3,4,5],alias:true,stream:'buffered stream',ports:['roundtrip','roundtrip'],trusted:true,reply:'client'});
    await page.evaluate(async()=>{
      const {ActorInbox}=await import('/host-worker/src/shared_worker/inbox.mjs'),pair=new MessageChannel();globalThis.streamCancelled=false;
      globalThis.cancelInbox=new ActorInbox(pair.port1,'cancel');globalThis.cancelSender=pair.port2;
      pair.port2.postMessage({sandstone_actor:'cancel',type:'hello',instance:'0123456789abcdef0123456789abcdef',phase:'ready'});await cancelInbox.ready;
      const stream=new ReadableStream({cancel(){streamCancelled=true;}});pair.port2.postMessage({stream},[stream]);
    });
    await page.waitForFunction(()=>cancelInbox.queue.length===1);await page.evaluate(()=>cancelInbox.close());await page.waitForFunction(()=>streamCancelled);await page.evaluate(()=>cancelSender.close());
    return ['Native actor handoff preserves buffered FIFO, aliases, trusted delivery, streams and referenced/unreferenced ports','Retiring an unbound actor inbox cancels its buffered native stream producer'];
  }finally{clearTimeout(deadline);await context.close();}
}
