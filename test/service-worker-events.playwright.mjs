import {listen_browser_server} from './browser-server.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {create_service_worker_events} from '../src/service_worker/events.mjs';
import {verifyServiceWorkerDispatcher} from './service-worker-dispatcher.playwright.mjs';

function worker_control(create){
  const api=create(),reports=new Map();
  self.addEventListener('error',event=>{self.lastControlError=event.message;});
  self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
  self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
  function constructors(Ctor){
    // Compare the shared constructor surface here. Newer FetchEventInit
    // promises/IDs, USVString conversion and synthetic respondWith guards have
    // separate unit coverage; Chromium predates those current IDL changes.
    const errors=[],attempt=fn=>{try{fn();return null;}catch(error){return error.name;}};
    errors.push(attempt(()=>new Ctor.ExtendableEvent()),attempt(()=>new Ctor.FetchEvent('fetch')),attempt(()=>new Ctor.FetchEvent('fetch',{})));
    const request=new Request(location.origin+'/asset'),preload=Promise.resolve('preload'),handled=Promise.resolve(17);
    const event=new Ctor.FetchEvent('fetch',{request,clientId:42});
    errors.push(attempt(()=>event.waitUntil()),attempt(()=>event.waitUntil(Promise.resolve())));
    errors.push(attempt(()=>Ctor.FetchEvent.prototype.respondWith.call(new Ctor.ExtendableEvent('install'),new Response('wrong brand'))));
    const reads=[],dictionary={};
    for(const key of ['bubbles','cancelable','composed','clientId','request','resultingClientId'])Object.defineProperty(dictionary,key,{get(){reads.push(key);return key==='request'?request:undefined;}});
    new Ctor.FetchEvent('fetch',dictionary);
    const channel=new MessageChannel(),payload={cache:['https://site.test/']};
    const message=new Ctor.ExtendableMessageEvent('message',{data:payload,origin:'https://site.test/',lastEventId:7,ports:[channel.port1],source:channel.port2});
    const messageResult={data:message.data===payload,origin:message.origin,id:message.lastEventId,port:message.ports[0]===channel.port1,source:message.source===channel.port2,frozen:Object.isFrozen(message.ports),tag:Object.prototype.toString.call(message)};
    channel.port1.close();channel.port2.close();
    return {errors,reads,request:event.request===request,preload:typeof event.preloadResponse.then,handled:typeof event.handled.then,client:event.clientId,trusted:event.isTrusted,tag:Object.prototype.toString.call(event),enumerable:Object.getOwnPropertyDescriptor(Ctor.FetchEvent.prototype,'request').enumerable,message:messageResult};
  }
  self.addEventListener('message',event=>{
    if(!event.data?.control)return;
    const port=event.ports[0],{action,virtual,mode,id}=event.data;
    if(action==='constructors'){port.postMessage({native:constructors(self),virtual:constructors(api)});return;}
    if(action==='report'){const report=reports.get(id);if(!report){port.postMessage(null);return;}const {bytes,...fields}=report;port.postMessage({...fields,buffer:bytes?.buffer.byteLength});return;}
    const run=view=>{
      const log=[['trusted',view.isTrusted],['target',view.target===self]];
      let release;const gate=new Promise(resolve=>release=resolve);
      if(mode!=='empty')view.waitUntil(mode==='pending'?gate:Promise.resolve());
      const later=()=>{
        log.push(['current target',view.currentTarget===self],['phase',view.eventPhase!==0],['path',view.composedPath().length]);
        try{view.waitUntil(Promise.resolve());log.push(['extension','allowed']);}catch(error){log.push(['extension',error.name]);}
        release();port.postMessage(log);
      };
      let turn=Promise.resolve();for(let count=0;count<(mode==='completed'?6:0);count++)turn=turn.then(()=>{});
      if(mode==='next task')setTimeout(later,0);else turn.then(later);
    };
    if(!virtual){run(event);return;}
    const listener=api.wrap_listener(run);self.addEventListener('probe-lifetime',listener,{once:true});
    api.dispatch_event(new api.ExtendableEvent('probe-lifetime'),(_,raw)=>self.dispatchEvent(raw),event);
  });
  self.addEventListener('fetch',event=>{
    if(!event.isTrusted)return;
    const url=new URL(event.request.url);if(url.pathname!=='/scope/response')return;
    const mode=url.searchParams.get('mode'),id=url.searchParams.get('id'),virtual=url.searchParams.get('virtual')==='1';
    const report={trusted:true},bytes=Uint8Array.from([9,1,2,3,9]);report.bytes=bytes;reports.set(id,report);
    let value;
    if(mode==='invalid')value={body:'fake'};
    else if(mode==='rejected')value=Promise.reject(new Error('response failed'));
    else if(mode==='error')value=Response.error();
    else if(mode==='bytes')value=new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(1,4));controller.close();}}));
    else if(mode==='bad chunk')value=new Response(new ReadableStream({start(controller){controller.enqueue('not bytes');}}));
    else if(mode==='body failure')value=new Response(new ReadableStream({start(controller){controller.error('private source failure');}}));
    else value=new Response(mode==='empty'?null:'answer',{headers:{'X-Value':'before','Set-Cookie':'worker_cookie=value'}});
    if(mode==='locked')value.body.getReader();
    if(mode==='used')value.text();
    if(!virtual){if(mode==='microtask')Promise.resolve().then(()=>event.respondWith(value));else event.respondWith(value);}
    else{
      const fake=new api.FetchEvent('fetch',{request:event.request,cancelable:true});
      const listener=api.wrap_listener(view=>{report.trusted=view.isTrusted;report.target=view.target===self;if(mode==='microtask')Promise.resolve().then(()=>view.respondWith(value));else view.respondWith(value);});
      self.addEventListener('fetch',listener,{once:true});
      const result=api.dispatch_event(fake,(_,raw)=>self.dispatchEvent(raw),event);
      event.waitUntil(result.lifetime.catch(()=>{}));
      event.respondWith(result.dispatched.then(()=>result.response).then(handle=>new Response(handle.reader?new ReadableStream({
        async pull(controller){try{const item=await handle.reader.read();if(item.done)controller.close();else controller.enqueue(item.value);}catch(error){controller.error(error);}},
        cancel:reason=>handle.reader.cancel(reason)
      }):null,{status:handle.metadata.status,statusText:handle.metadata.statusText,headers:handle.metadata.headers})));
      event.handled.then(()=>api.finish_fetch(fake),error=>api.finish_fetch(fake,error));
    }
    if(mode==='headers')Promise.resolve().then(()=>value.headers.set('X-Value','after'));
  });
}

function dedicated_control(create){
  const api=create();
  self.onmessage=async parent=>{
    try{
      const event=new api.FetchEvent('fetch',{request:new Request('https://virtual-site.test/asset')});
      const result=api.dispatch_event(event,view=>{Promise.resolve().then(()=>view.respondWith(new Response('file worker')));},parent);
      await result.dispatched;const handle=await result.response,parts=[];
      for(;;){const part=await handle.reader.read();if(part.done)break;parts.push(...part.value);}
      await result.lifetime;api.finish_fetch(event);await event.handled;
      postMessage({text:new TextDecoder().decode(Uint8Array.from(parts)),trusted:result.event.isTrusted,target:result.event.target===self,origin:location.origin});
    }catch(error){postMessage({error:error.name,message:error.message});}
  };
}

async function verifyFileWorkerEvents(page){
  const host=new URL('../.temp/service-worker-event-host.html',import.meta.url);
  await mkdir(new URL('.',host),{recursive:true});await writeFile(host,'<!doctype html><title>File worker event control</title>');
  await page.goto(host.href);
  const source=`(${dedicated_control})(${create_service_worker_events});`;
  const file=await page.evaluate(source=>new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'})),worker=new Worker(url),timer=setTimeout(()=>{cleanup();reject(new Error('File worker event timed out'));},10000);
    function cleanup(){clearTimeout(timer);worker.terminate();URL.revokeObjectURL(url);}
    worker.onmessage=event=>{cleanup();resolve(event.data);};worker.onerror=event=>{event.preventDefault();cleanup();reject(new Error(event.message));};worker.postMessage(null);
  }),source);
  assert.equal(file.text,'file worker');assert.equal(file.trusted,true);assert.equal(file.target,true);
  const opaque=await page.evaluate(source=>new Promise((resolve,reject)=>{
    const frame=document.createElement('iframe');frame.sandbox='allow-scripts';
    const timer=setTimeout(()=>{cleanup();reject(new Error('Opaque file worker event timed out'));},10000);
    function cleanup(){clearTimeout(timer);removeEventListener('message',receive);frame.remove();}
    function receive(event){if(event.source!==frame.contentWindow||!event.data?.workerEventControl)return;const data=event.data;cleanup();if(data.error)reject(new Error(data.error));else resolve(data.value);}
    addEventListener('message',receive);
    const child=`const url=URL.createObjectURL(new Blob([${JSON.stringify(source)}],{type:'text/javascript'}));const worker=new Worker(url);worker.onmessage=event=>{worker.terminate();URL.revokeObjectURL(url);parent.postMessage({workerEventControl:true,value:event.data},'*');};worker.onerror=event=>{event.preventDefault();parent.postMessage({workerEventControl:true,error:event.message},'*');};worker.postMessage(null);`;
    frame.srcdoc='<script>'+child.replace(/<\/script/gi,'<\\/script')+'<\/script>';document.body.append(frame);
  }),source);
  assert.deepEqual(opaque,{text:'file worker',trusted:true,target:true,origin:'null'});
  return ['Service worker event core executes in a file-hosted dedicated worker','Service worker event core executes in an opaque sandbox worker under file:'];
}

export async function verifyServiceWorkerEvents(browser){
  const script=`(${worker_control})(${create_service_worker_events});`;
  const sockets=new Set(),server=createServer((request,response)=>{
    if(request.url==='/scope/worker.js'){response.setHeader('Content-Type','text/javascript');response.end(script);}
    else{response.setHeader('Content-Type','text/html');response.end('<!doctype html>Native service worker event control');}
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await listen_browser_server(server);
  const context=await browser.newContext();
  try{
    const page=await context.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/scope/client');
    const results=await page.evaluate(async()=>{
      await navigator.serviceWorker.register('/scope/worker.js');await navigator.serviceWorker.ready;
      if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
      const command=data=>new Promise((resolve,reject)=>{
        const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();reject(new Error('Service worker event control timed out: '+JSON.stringify(data)));},10000);
        channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();resolve(event.data);};
        navigator.serviceWorker.controller.postMessage({control:true,...data},[channel.port2]);
      });
      const results=[{name:'constructors',...await command({action:'constructors'})}];
      for(const mode of ['empty','pending','settled','completed','next task'])results.push({name:'lifetime '+mode,native:await command({action:'lifetime',mode}),virtual:await command({action:'lifetime',mode,virtual:true})});
      for(const mode of ['plain','empty','headers','bytes','microtask','invalid','rejected','error','locked','used','bad chunk','body failure']){
        const values=[];
        for(const virtual of [false,true]){
          const id=mode+'-'+Number(virtual),value={};
          try{const response=await fetch('/scope/response?'+new URLSearchParams({mode,id,virtual:Number(virtual)}));value.status=response.status;value.type=response.type;value.header=response.headers.get('x-value');value.cookie=response.headers.get('set-cookie');value.bytes=[...new Uint8Array(await response.arrayBuffer())];}catch(error){value.error=error.name;}
          if(mode==='bytes'){const report=await command({action:'report',id});value.detached=report.buffer===0;value.trusted=report.trusted;}
          values.push(value);
        }
        results.push({name:'response '+mode,native:values[0],virtual:values[1]});
      }
      results.push({name:'synthetic response cookies',native:'',virtual:document.cookie});
      for(const registration of await navigator.serviceWorker.getRegistrations())await registration.unregister();
      return results;
    });
    for(const result of results)assert.deepEqual(result.virtual,result.native,'Service worker event '+result.name);
    return [...results.map(result=>'Service worker native event parity: '+result.name),...await verifyFileWorkerEvents(page),...await verifyServiceWorkerDispatcher(page)];
  }catch(error){for(const worker of context.serviceWorkers())console.error('Service worker control error:',await worker.evaluate(()=>self.lastControlError).catch(value=>String(value)));throw error;}
  finally{await context.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
}
