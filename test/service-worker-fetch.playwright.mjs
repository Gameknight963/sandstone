import assert from 'node:assert/strict';

export async function verifyServiceWorkerFetch(page){
  const fixture=await page.context().newPage(),origin='https://worker-fetch.test',errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));
  fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
  try{
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.evaluate(async origin=>{
      main_frame.on_load=()=>{};main_frame.special_pages[origin+'/page']='<!doctype html><body>Controlled page';await main_frame.navigate_to(origin+'/page');
      const source=`oninstall=event=>event.waitUntil(caches.open('fetch-test').then(cache=>cache.put('/cached',new Response('saved'))));
        onactivate=event=>event.waitUntil(clients.claim());
        onfetch=event=>{
          const path=new URL(event.request.url).pathname;
          if(path==='/fallback'){event.waitUntil(event.handled.then(()=>caches.open('fetch-test').then(cache=>cache.put('/handled',new Response('yes')))));return;}
          if(path==='/cached'||path==='/handled'){event.respondWith(caches.match(event.request));return;}
          if(path==='/pass'){event.respondWith(fetch(event.request.clone()));return;}
          if(path==='/abort'){
            event.respondWith(new Promise(resolve=>event.request.signal.addEventListener('abort',()=>{
              caches.open('fetch-test').then(cache=>cache.put('/aborted',new Response('yes')));resolve(new Response('late'));
            },{once:true})));return;
          }
          if(path==='/aborted'||path==='/stream-aborted'){event.respondWith(caches.match(event.request));return;}
          if(path==='/stream-abort'){
            event.request.signal.addEventListener('abort',()=>caches.open('fetch-test').then(cache=>cache.put('/stream-aborted',new Response('yes'))),{once:true});
            event.respondWith(new Response(new ReadableStream({start(controller){controller.enqueue(Uint8Array.of(65));}})));return;
          }
          if(path==='/redirect'){event.respondWith(Response.redirect(new URL('/synthetic',event.request.url).href,302));return;}
          if(path==='/error'){event.respondWith(Response.error());return;}
          if(path==='/empty'){event.waitUntil(event.handled);event.respondWith(new Response(null,{status:204}));return;}
          if(path==='/echo'){event.respondWith(new Response(event.request.body));return;}
          if(path==='/inspect'){event.respondWith(new Response(JSON.stringify({cookie:event.request.headers.get('cookie'),destination:event.request.clone().destination,referrer:event.request.clone().referrer,client:!!event.clientId})));return;}
          event.respondWith(new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('worker'));controller.close();}}),{headers:{'set-cookie':'forged=1'}}));
        };`;
      globalThis.fetchTestNetwork=[];
      sandstone.network.session.fetch=async(url,options)=>{
        fetchTestNetwork.push({url,method:options.method,headers:options.headers});
        return new Response(new URL(url).pathname==='/worker.js'?source:'network',{headers:{'content-type':new URL(url).pathname==='/worker.js'?'text/javascript':'text/plain','cache-control':'no-store'}});
      };
      const manager=sandstone.service_workers.manager;
      globalThis.fetchTestClient=manager.addClient({id:main_frame.document_context,frame:main_frame.id,url:main_frame.url.href});
      globalThis.fetchTestRecord=await manager.register(origin+'/worker.js',{}, {base:origin+'/page',origin});await manager.settled(fetchTestRecord);
      if(fetchTestClient.controller!==fetchTestRecord.active)throw new Error('Worker did not claim the client');
    },origin);
    const result=JSON.parse(await fixture.evaluate(()=>main_frame.eval_js(`(async()=>{
      const text=async path=>(await fetch(path)).text();
      const synthetic=await fetch('/synthetic'),cookie=synthetic.headers.get('set-cookie'),body=await synthetic.text();
      const cached=await text('/cached'),fallback=await text('/fallback'),pass=await text('/pass');
      const echo=await(await fetch('/echo',{method:'POST',body:'posted'})).text();
      const empty=await fetch('/empty');let error;try{await fetch('/error');}catch(value){error=value.name;}
      const redirect=await fetch('/redirect');const redirected={body:await redirect.text(),redirected:redirect.redirected};
      const manual=await fetch('/redirect',{redirect:'manual'}),manualRedirect={status:manual.status,ok:manual.ok,type:manual.type,body:manual.body};
      const inspect=JSON.parse(await text('/inspect'));
      for(let i=0;i<100;i++){if(await text('/handled')==='yes')break;await new Promise(resolve=>setTimeout(resolve,10));}
      const controller=new AbortController(),pending=fetch('/abort',{signal:controller.signal}).then(()=>null,error=>error.name);
      setTimeout(()=>controller.abort(),150);const aborted=await pending;
      let notified=false;for(let i=0;i<100;i++){try{notified=await text('/aborted')==='yes';}catch{}if(notified)break;await new Promise(resolve=>setTimeout(resolve,10));}
      const streamAbort=new AbortController(),stream=await fetch('/stream-abort',{signal:streamAbort.signal}),reader=stream.body.getReader();await reader.read();streamAbort.abort();
      let streamError;try{await reader.read();}catch(error){streamError=error.name;}
      let streamNotified=false;for(let i=0;i<100;i++){try{streamNotified=await text('/stream-aborted')==='yes';}catch{}if(streamNotified)break;await new Promise(resolve=>setTimeout(resolve,10));}
      return JSON.stringify({body,cookie,cached,fallback,pass,echo,empty:empty.status,error,redirected,manualRedirect,inspect,aborted,notified,streamError,streamNotified});
    })()`)));
    assert.deepEqual(result,{body:'worker',cookie:null,cached:'saved',fallback:'network',pass:'network',echo:'posted',empty:204,error:'TypeError',redirected:{body:'worker',redirected:true},manualRedirect:{status:0,ok:false,type:'opaqueredirect',body:null},inspect:{cookie:null,destination:'',referrer:origin+'/page',client:true},aborted:'AbortError',notified:true,streamError:'AbortError',streamNotified:true});
    const resource=await fixture.evaluate(async origin=>{
      const response=await sandstone.network.fetch(origin+'/inspect',{mode:'cors',destination:'image'}, {url:main_frame.url.href,frame_id:main_frame.id,service_worker_client:main_frame.document_context});
      return response.json();
    },origin);
    assert.deepEqual(resource,{cookie:null,destination:'image',referrer:origin+'/page',client:true});
    const network=await fixture.evaluate(()=>fetchTestNetwork.map(value=>new URL(value.url).pathname));
    assert.deepEqual(network,['/worker.js','/fallback','/pass']);
    await fixture.waitForFunction(()=>fetchTestRecord.active.pending===0);
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Controlled page fetches stream synthetic and cached worker responses through the relay','Unhandled fetches and worker pass-through use the HTTP pipeline once','Worker fetches preserve bodies, request context, redirects and response errors','Abort reaches pending worker requests and retired streams cannot resurrect','Fetch delivery acknowledgements settle background work and release owner reservations'];
  }finally{
    await fixture.evaluate(async origin=>{await sandstone.service_workers.clear_registrations(new URL(origin).hostname);if(globalThis.fetchTestClient)sandstone.service_workers.manager.removeClient(fetchTestClient.id);}).catch(()=>{});
    await fixture.close();
  }
}
