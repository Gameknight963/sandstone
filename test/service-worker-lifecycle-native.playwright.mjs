import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';

export async function verifyNativeWorkerLifecycle(browser){
  const server=createServer((request,response)=>{
    const url=new URL(request.url,'http://localhost'),version=url.searchParams.get('v');
    response.setHeader('Content-Type',url.pathname==='/worker.js'?'text/javascript':'text/html');response.setHeader('Cache-Control','no-store');
    response.end(url.pathname==='/worker.js'?`let release;
      oninstall=event=>event.waitUntil(${version==='1'?'skipWaiting()':'Promise.resolve()'});
      onactivate=event=>event.waitUntil(clients.claim());
      onfetch=event=>{if(new URL(event.request.url).pathname==='/stream')event.respondWith(new Response(new ReadableStream({start(controller){controller.enqueue(Uint8Array.of(41));release=()=>controller.close()}})))};
      onmessage=event=>{
        if(event.data==='hold'){event.waitUntil(new Promise(resolve=>release=resolve));event.ports[0].postMessage('held')}
        if(event.data==='release')release();
        if(event.data==='skip'){const promise=skipWaiting();event.waitUntil(promise);promise.then(()=>event.ports[0].postMessage('resolved'));event.ports[0].postMessage('requested');}
      };`:'<!doctype html>Native lifecycle control');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const passed=[];
  try{
    for(const mode of ['event','body']){
      const context=await browser.newContext();
      try{
        const page=await context.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
        const result=await page.evaluate(async mode=>{
          const wait=async predicate=>{const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw new Error('Native lifecycle control timed out');await new Promise(resolve=>setTimeout(resolve,10));}};
          const reg=await navigator.serviceWorker.register('/worker.js?v=1');await navigator.serviceWorker.ready;await wait(()=>navigator.serviceWorker.controller);
          const first=reg.active,ask=(worker,data)=>new Promise((resolve,reject)=>{const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();reject(new Error('Native worker did not reply'));},5000);channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();resolve(event.data)};worker.postMessage(data,[channel.port2]);});
          let reader;if(mode==='body'){reader=(await fetch('/stream')).body.getReader();await reader.read();}else await ask(first,'hold');
          await navigator.serviceWorker.register('/worker.js?v=2');await wait(()=>reg.waiting);
          let skipRequested=false,skipResolved=false;const channel=new MessageChannel();
          channel.port1.onmessage=event=>{if(event.data==='requested')skipRequested=true;else if(event.data==='resolved'){skipResolved=true;channel.port1.close();}};
          reg.waiting.postMessage('skip',[channel.port2]);await wait(()=>skipRequested);
          await new Promise(resolve=>setTimeout(resolve,100));
          const pending={version:new URL(reg.active.scriptURL).searchParams.get('v'),state:first.state,skipResolved};
          const end=reader?.read();first.postMessage('release');const ended=end?(await end).done:null;
          await wait(()=>new URL(reg.active.scriptURL).searchParams.get('v')==='2'&&reg.active.state==='activated');await wait(()=>skipResolved);await reg.unregister();
          return {pending,ended};
        },mode);
        assert.deepEqual(result,{pending:{version:'1',state:'activated',skipResolved:false},ended:mode==='body'?true:null});
        passed.push('Native replacement waits for the old worker '+(mode==='body'?'response body':'extended event'));
      }finally{await context.close();}
    }
    return passed;
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
