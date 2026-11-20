import assert from 'node:assert/strict';

export async function verifyServiceWorkerRuntime(page){
  const origin='https://service-worker-runtime.test',html='<!doctype html><body>Service worker runtime';
  await page.evaluate(({origin,html})=>{
    const previous=sandstone.network.session.fetch;
    sandstone.network.session.fetch=(url,options)=>new URL(url).origin===origin?Promise.resolve(new Response(url.endsWith('dependency.js')?'self.importedValue=41;':html,{headers:{'Content-Type':url.endsWith('.js')?'text/javascript':'text/html'}})):previous(url,options);
  },{origin,html});
  await page.evaluate(url=>main_frame.navigate_to(url),origin+'/page');
  const frame=await (await page.locator('iframe[frame-id]').elementHandle()).contentFrame();
  for(const type of ['classic','module']){
  const report=await frame.evaluate(async({origin,type})=>{
    const source=`${type==='module'?"import './dependency.js';":"importScripts('./dependency.js');"}
      addEventListener('install',event=>event.waitUntil((async()=>{
        const cache=await caches.open('service-worker-runtime');
        await cache.put(registration.scope+'resource',new Response('cached '+importedValue));
        await skipWaiting();
      })()));
      onfetch=event=>event.respondWith(caches.match(event.request));
      onmessage=event=>{
        event.ports[0].postMessage({value:event.data,origin:event.origin,scope:registration.scope,url:location.href,
          worker:typeof Worker,post:typeof postMessage,close:typeof close,constructor:typeof ExtendableEvent,trusted:event.isTrusted});
        event.waitUntil(Promise.resolve());
      };`;
    const worker=sandstone_frame.worker.create_service_worker({scriptURL:origin+'/worker.js',scope:origin+'/',source,type});
    const packets=[],waiting=[],commands=[];
    const receive=packet=>{
      if(packet.type==='command'){commands.push(packet.method);worker.postMessage({type:'command-result',id:packet.id});return;}
      const index=waiting.findIndex(item=>(item.type===packet.type||packet.type==='error')&&item.id===packet.id||packet.type==='startup-error');
      if(index===-1)packets.push(packet);else waiting.splice(index,1)[0].resolve(packet);
    };
    const wait=(type,id)=>new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Service worker runtime timed out: '+type+' '+id+' packets='+JSON.stringify(packets))),15000);
      const done=value=>{clearTimeout(timer);if(value.error)reject(new Error(JSON.stringify({error:value.error,commands})));else resolve(value);};
      const index=packets.findIndex(item=>(item.type===type||item.type==='error')&&item.id===id||item.type==='startup-error');
      if(index!==-1)done(packets.splice(index,1)[0]);else waiting.push({type,id,resolve:done});
    });
    worker.onmessage=event=>receive(event.data);
    worker.onerror=event=>{event.preventDefault();receive({type:'startup-error',error:{message:event.message,stack:event.error?.stack}});};
    try{
      worker.postMessage({type:'dispatch',id:1,event:'install'});
      await wait('ready');
      await wait('dispatched',1);await wait('lifetime',1);
      worker.postMessage({type:'dispatch',id:2,event:'fetch',request:{url:origin+'/resource'}});
      const response=await wait('response',2);worker.postMessage({type:'handled',id:2});
      const bytes=[];
      for(;;){worker.postMessage({type:'read',id:2});const chunk=await wait('chunk',2);if(chunk.done)break;bytes.push(...chunk.value);}
      const channel=new MessageChannel();
      const message=new Promise(resolve=>channel.port1.onmessage=event=>resolve(event.data));
      worker.postMessage({type:'dispatch',id:3,event:'message',data:'hello',origin,ports:[channel.port2]},[channel.port2]);
      const value=await message;channel.port1.close();await wait('dispatched',3);await wait('lifetime',3);
      return {text:new TextDecoder().decode(new Uint8Array(bytes)),status:response.metadata.status,commands,message:value};
    }finally{worker.terminate();}
  },{origin,type});
  assert.deepEqual(report,{text:'cached 41',status:200,commands:['skipWaiting'],message:{value:'hello',origin,scope:origin+'/',url:origin+'/worker.js',worker:'undefined',post:'undefined',close:'undefined',constructor:'function',trusted:true}});
  }
  return ['Classic and module service worker scripts execute relayed imports and populate origin-scoped CacheStorage','Service worker startup buffers lifecycle events until its script finishes','Service worker fetch dispatch streams cached responses through the private owner transport','Service worker message delivery transfers ports and hides dedicated-worker globals'];
}
