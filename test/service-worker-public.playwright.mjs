import assert from 'node:assert/strict';

export async function verifyPublicServiceWorker(page){
  const fixture=await page.context().newPage(),origin='https://public-worker.test',direct=[],errors=[];
  const wait=script=>fixture.evaluate(async script=>{const deadline=Date.now()+10000;while(!await main_frame.eval_js(script)){if(Date.now()>deadline)throw new Error('Public service worker state timed out: '+script);await new Promise(resolve=>setTimeout(resolve,10));}},script);
  fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});fixture.on('pageerror',error=>errors.push(error.message));
  try{
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.evaluate(async origin=>{
      await sandstone.service_workers.clear_registrations(new URL(origin).hostname);
      globalThis.publicVersion=1;globalThis.publicGateHold=true;globalThis.publicGateStarted=false;globalThis.publicOffline=false;
      sandstone.network.session.fetch=async url=>{
        const path=new URL(url).pathname;
        if(path==='/install-gate'&&publicGateHold){publicGateStarted=true;await new Promise(resolve=>globalThis.publicRelease=resolve);}
        const source=`const version=${publicVersion};let releaseActivation,activationRequested=false;
          oninstall=event=>event.waitUntil(fetch('/install-gate').then(()=>caches.open('public').then(cache=>cache.put('/value',new Response('version-'+version)))));
          onactivate=event=>event.waitUntil((async()=>{await clients.claim();if(version===1)await new Promise(resolve=>{releaseActivation=resolve;if(activationRequested)resolve();});})());
          onfetch=event=>{if(new URL(event.request.url).pathname==='/value')event.respondWith(caches.match('/value'));};
          addEventListener('fetch',event=>{if(new URL(event.request.url).pathname==='/offline')event.respondWith(new Response('<body>Offline public worker<script>globalThis.initialController=!!navigator.serviceWorker.controller;globalThis.initialReady=navigator.serviceWorker.ready;</'+'script>',{headers:{'content-type':'text/html'}}));});
          onmessage=event=>{
            if(event.data==='release-activation'){activationRequested=true;releaseActivation?.();return;}
            if(event.data==='skip'){event.waitUntil(skipWaiting());return;}
            if(event.data==='source'){event.source.postMessage({version,id:event.source.id,url:event.source.url,type:event.source.type,tag:Object.prototype.toString.call(event.source)});return;}
            event.waitUntil((async()=>{
              if(event.data?.key){const signature=await crypto.subtle.sign('HMAC',event.data.key,new TextEncoder().encode('message'));event.ports[0].postMessage({key:event.data.key,signature:[...new Uint8Array(signature)],version});return;}
              const matches=await clients.matchAll({includeUncontrolled:true});const source=await clients.get(event.source.id);
              event.ports[0].postMessage({version,bytes:event.data?.bytes?[...new Uint8Array(event.data.bytes)]:null,same:source===event.source,listed:matches.some(client=>client.id===source.id),origin:event.origin});
            })());
          };`;
        if(publicOffline)throw new TypeError('Offline');
        return new Response(path==='/worker.js'?source:'<!doctype html><body>Public service worker fixture',{headers:{'content-type':path==='/worker.js'?'text/javascript':'text/html','cache-control':'no-store'}});
      };
      main_frame.on_load=()=>{};await main_frame.navigate_to(origin+'/page');
    },origin);
    const registered=JSON.parse(await fixture.evaluate(()=>main_frame.eval_js(`(async()=>{
      const service=navigator.serviceWorker;globalThis.publicEvents=[];globalThis.publicReady=service.ready;
      service.oncontrollerchange=event=>publicEvents.push(['controller',event.isTrusted,event.target===service]);
      globalThis.publicRegistration=await service.register('/worker.js');
      EventTarget.prototype.addEventListener.call(publicRegistration,'updatefound',event=>publicEvents.push(['update',event.isTrusted,event.target===publicRegistration]));
      publicRegistration.installing.onstatechange=event=>publicEvents.push(['state',event.isTrusted,event.target.state]);
      return JSON.stringify({installing:publicRegistration.installing.state,same:await service.getRegistration()===publicRegistration,list:(await service.getRegistrations()).length,ready:publicReady===service.ready,registration:publicRegistration instanceof ServiceWorkerRegistration,container:service instanceof ServiceWorkerContainer,worker:publicRegistration.installing instanceof ServiceWorker});
    })()`)));
    assert.deepEqual(registered,{installing:'installing',same:true,list:1,ready:true,registration:true,container:true,worker:true});
    await fixture.waitForFunction(()=>publicGateStarted);
    await fixture.evaluate(()=>{publicGateHold=false;publicRelease();});
    const activating=await fixture.evaluate(()=>main_frame.eval_js('(async()=>{const registration=await navigator.serviceWorker.ready;registration.active.postMessage("release-activation");return registration.active.state;})()'));assert.equal(activating,'activating');
    await wait('!!navigator.serviceWorker.controller&&navigator.serviceWorker.controller.state==="activated"');
    const activated=JSON.parse(await fixture.evaluate(()=>main_frame.eval_js(`(async()=>JSON.stringify({ready:await publicReady===publicRegistration,controller:navigator.serviceWorker.controller===publicRegistration.active,active:publicRegistration.active?.scriptURL,controllerURL:navigator.serviceWorker.controller?.scriptURL,value:await(await fetch('/value')).text(),events:publicEvents}))()`)));
    assert.equal(activated.ready,true);assert.equal(activated.controller,true);assert.equal(activated.value,'version-1');
    assert.ok(activated.events.some(event=>event[0]==='update'&&event[1]&&event[2]));assert.ok(activated.events.some(event=>event[0]==='controller'&&event[1]&&event[2]));assert.ok(activated.events.some(event=>event[0]==='state'&&event[1]&&event[2]==='activated'));
    const reply=JSON.parse(await fixture.evaluate(()=>main_frame.eval_js(`(async()=>{
      const channel=new MessageChannel(),received=new Promise(resolve=>channel.port1.onmessage=event=>resolve(event.data));
      const bytes=Uint8Array.of(1,2,3).buffer;navigator.serviceWorker.controller.postMessage({bytes},[bytes,channel.port2]);
      const detached=bytes.byteLength===0,value=await received;channel.port1.close();return JSON.stringify({detached,value});
    })()`)));
    assert.deepEqual(reply,{detached:true,value:{version:1,bytes:[1,2,3],same:true,listed:true,origin}});
    const source=JSON.parse(await fixture.evaluate(()=>main_frame.eval_js(`(async()=>{
      const received=new Promise(resolve=>navigator.serviceWorker.onmessage=event=>resolve({value:event.data,origin:event.origin,trusted:event.isTrusted,same:event.source===navigator.serviceWorker.controller,target:event.target===navigator.serviceWorker}));
      navigator.serviceWorker.controller.postMessage('source');return JSON.stringify(await received);
    })()`)));
    assert.deepEqual(source,{value:{version:1,id:await fixture.evaluate(()=>main_frame.document_context),url:origin+'/page',type:'window',tag:'[object WindowClient]'},origin,trusted:true,same:true,target:true});
    const crypto=JSON.parse(await fixture.evaluate(()=>main_frame.eval_js(`(async()=>{
      const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('secret'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
      const channel=new MessageChannel(),received=new Promise(resolve=>channel.port1.onmessage=event=>resolve(event.data));navigator.serviceWorker.controller.postMessage({key},[channel.port2]);
      const value=await received;channel.port1.close();const expected=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('message'));
      return JSON.stringify({key:value.key instanceof CryptoKey,extractable:value.key.extractable,same:JSON.stringify(value.signature)===JSON.stringify([...new Uint8Array(expected)])});
    })()`)));
    assert.deepEqual(crypto,{key:true,extractable:false,same:true});
    await fixture.evaluate(()=>{publicVersion=2;});
    await fixture.evaluate(()=>main_frame.eval_js('(async()=>{await publicRegistration.update();return true;})()'));
    await wait('!!publicRegistration.waiting');
    await fixture.evaluate(()=>main_frame.eval_js('publicRegistration.waiting.postMessage("skip")'));
    await wait('publicRegistration.active===navigator.serviceWorker.controller&&navigator.serviceWorker.controller.state==="activated"&&publicRegistration.waiting===null');
    const changed=await fixture.evaluate(()=>main_frame.eval_js('fetch("/value").then(response=>response.text())'));assert.equal(changed,'version-2');
    await fixture.evaluate(async origin=>{publicOffline=true;await main_frame.navigate_to(origin+'/offline');},origin);
    const offline=JSON.parse(await fixture.evaluate(()=>main_frame.eval_js(`(async()=>JSON.stringify({initial:initialController,ready:await initialReady===await navigator.serviceWorker.getRegistration(),controller:navigator.serviceWorker.controller===(await initialReady).active,value:await(await fetch('/value')).text()}))()`)));
    assert.deepEqual(offline,{initial:true,ready:true,controller:true,value:'version-2'});
    const removed=JSON.parse(await fixture.evaluate(()=>main_frame.eval_js(`(async()=>{const registration=await navigator.serviceWorker.getRegistration();return JSON.stringify({removed:await registration.unregister(),lookup:await navigator.serviceWorker.getRegistration()===undefined,list:(await navigator.serviceWorker.getRegistrations()).length,controlled:!!navigator.serviceWorker.controller});})()`)));
    assert.deepEqual(removed,{removed:true,lookup:true,list:0,controlled:true});
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Public register/getRegistration/getRegistrations preserve object identity and native lifecycle events','Ready and controller state reflect actual installation, activation and claims','ServiceWorker/Client messaging preserves source identity and native transfer semantics','Transferred CryptoKeys remain nonextractable and usable across worker messages','Public update, waiting-worker messages, skipWaiting and unregister use the real manager','Public registrations control offline navigation before the next document runs scripts'];
  }finally{await fixture.evaluate(origin=>sandstone.service_workers.clear_registrations(new URL(origin).hostname),origin).catch(()=>{});await fixture.close();}
}
