import assert from 'node:assert/strict';

export function retained_worker_main(){
  const hosts=new Map(),closed=new Map(),watchers=new Map();
  const providers=new sandstone.PolicyProviders();
  const cookie_policy=new sandstone.CookiePolicyBridge((message,options)=>providers.request(message,options));
  onconnect=event=>{
    const port=event.ports[0];
    port.onmessage=async event=>{
      const {id,op,context}=event.data;
      try{
        if(op==='policy'){
          providers.add(event.ports[0],{lease:event.data.lease,authority:event.data.authority});
          port.postMessage({policy:true});
        }else if(op==='open'){
          await sandstone.controller.indexed_db.ready;await sandstone.libcurl.load_wasm();
          sandstone.network.set_websocket(location.origin.replace(/^http/,'ws')+'/');
          const host=new sandstone.WorkerServiceHost({...context,cookie_policy},event.ports[0]);hosts.set(id,host);
          sandstone.controller.site_data.setCookie(context.top_url,'owner-only=secret; Path=/');
          port.postMessage({id,profile:host.profile,persistent:sandstone.controller.indexed_db.persistent});
        }else if(op==='control'){
          const control=event.ports[0];
          control.onmessage=event=>{
            if(event.data?.sandstone_worker!==id||event.data.type!=='closed')return;
            hosts.get(id)?.close();hosts.delete(id);control.close();
            const result={id,frames:Object.keys(sandstone.controller.iframes).length};closed.set(id,result);
            watchers.get(id)?.postMessage(result);watchers.delete(id);
          };control.start();port.postMessage({id,retained:true});
        }else if(op==='watch-close'){
          if(closed.has(id))port.postMessage(closed.get(id));else watchers.set(id,port);
        }else if(op==='close'){
          hosts.get(id)?.close();hosts.delete(id);
          port.postMessage({id,frames:Object.keys(sandstone.controller.iframes).length});
        }
      }catch(error){port.postMessage({id,error:{name:error.name,message:error.message,stack:error.stack}});}
    };port.start();
  };
}

function worker_surface(event,receiver){
  return {scope:Object.prototype.toString.call(self),postMessage:typeof postMessage,worker:typeof Worker,postMessagePresent:'postMessage' in self,workerPresent:'Worker' in self,sharedBrand:self instanceof SharedWorkerGlobalScope,target:event.target===self,currentTarget:event.currentTarget===self,receiver:receiver===self,path:event.composedPath().map(value=>value===self?'self':String(value)),connectOrigin:event.origin,trusted:event.isTrusted,bootstrapOwner:typeof owner};
}

function authored_worker(){
  let counter=0;
  const cookieValues=value=>value.split('; ').filter(value=>/^(worker_session|worker_redirect|fresh)=/.test(value)).join('; ');
  const key=crypto.subtle.generateKey({name:'HMAC',hash:'SHA-256'},false,['sign']);
  const open=()=>new Promise((resolve,reject)=>{
    const request=indexedDB.open('retained-worker',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('values');
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  const connect=function(event){
    const surface=worker_surface(event,this);
    const port=event.ports[0];port.onmessage=async event=>{
      if(event.data==='close'){close();return;}
      try{
        if(event.data==='hold-socket'){
          const cookies=await new Promise((resolve,reject)=>{
            const ws=new WebSocket(new URL('./socket-held',location.href).href.replace(/^http/,'ws'));
            ws.onerror=()=>reject(new Error('Held worker WebSocket failed'));
            ws.onopen=()=>fetch('./cookie-end',{credentials:'include'}).then(response=>response.text()).then(value=>{ws.close(1000);resolve(value);},reject);
          });
          port.postMessage({clearedSocketCookies:cookies});return;
        }
        if(event.data==='hold'){
          await(await fetch('./cookie-held',{credentials:'include'})).text();
          port.postMessage({clearedCookies:await(await fetch('./cookie-end',{credentials:'include'})).text()});return;
        }
        const transport=await(await fetch('./data',{credentials:'omit'})).text();
        const cookies=cookieValues(await(await fetch('./cookie-start',{credentials:'include'})).text());
        const socket=await new Promise((resolve,reject)=>{
          const events=[],ws=new WebSocket(new URL('./socket',location.href).href.replace(/^http/,'ws'),['other','retained']);let metadata,committed;
          ws.onopen=()=>{
            events.push('open');committed=fetch('./cookie-end',{credentials:'include'}).then(response=>response.text()).then(value=>value.includes('worker_socket=handshake')&&!value.includes('socket_scoped=private'));
            ws.send('echo');
          };
          ws.onmessage=event=>{if(event.data==='echo'){events.push('echo');ws.close(1000);}else{events.push('metadata');metadata=JSON.parse(event.data);}};
          ws.onerror=()=>reject(new Error('Retained authenticated WebSocket failed'));
          ws.onclose=()=>{events.push('close');Promise.resolve(committed).then(value=>resolve({...metadata,protocol:ws.protocol,committed:value,events}),reject);};
        });
        const refused=await new Promise((resolve,reject)=>{
          const ws=new WebSocket(new URL('./socket-refused',location.href).href.replace(/^http/,'ws'));
          ws.onopen=()=>reject(new Error('A refused WebSocket unexpectedly opened'));
          ws.onerror=()=>{};
          ws.onclose=()=>fetch('./cookie-end',{credentials:'include'}).then(response=>response.text()).then(value=>resolve(value.includes('worker_refused=kept')),reject);
        });
        const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',await key,new Uint8Array([4,5,6]))));
        const db=await open();let value;
        await new Promise((resolve,reject)=>{
          const tx=db.transaction('values',event.data==='write'?'readwrite':'readonly'),store=tx.objectStore('values');
          if(event.data==='write')store.put(new Uint8Array([17,34,51]),'saved');
          const request=store.get('saved');request.onsuccess=()=>value=request.result;
          tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
        });db.close();
        port.postMessage({counter:++counter,surface,origin,transport,cookies,socket,refused,signature,stored:value?[...value]:null});
      }catch(error){port.postMessage({error:{name:error.name,message:error.message,stack:error.stack}});}
    };port.start();
  };
  if(useEventListener)addEventListener('connect',connect);else onconnect=connect;
}

async function install_policy_provider(page,origin,denied,type,seed=true){
  await page.goto(origin+'/host-worker/page');
  if(denied)await page.evaluate(()=>{Object.defineProperty(globalThis,'localStorage',{get(){throw new DOMException('Storage denied','SecurityError');}});Object.defineProperty(globalThis,'sessionStorage',{get(){throw new DOMException('Storage denied','SecurityError');}});});
  await page.addScriptTag({url:origin+'/host-worker/bundle.js'});
  await page.evaluate(async({denied,type,seed})=>{
    const store=sandstone.controller.site_data,handle=sandstone.cookie_policy_handler(store);await store.ready;
    if(seed){
      store.setCookie(location.origin,'worker_session=secret; HttpOnly; SameSite=None; Secure; Path=/',true);
      store.setCookie(location.origin,'blocked=strict; SameSite=Strict; Path=/',true);
    }
    const provider=await sandstone.create_policy_provider(async(message,options)=>{
      if(globalThis.policyHoldHeader&&message.op==='header'){globalThis.policyHeld={header:true};await new Promise(()=>{});}
      const value=await handle(message,options);
      if(globalThis.policyHoldSet&&message.op==='set'){globalThis.policyHeld={cookie:message.options.cookieWrite.cookie,version:message.options.cookieWrite.id};await new Promise(()=>{});}
      return value;
    },{authority:()=>store.cookiePolicyAuthority()});
    globalThis.retainedPolicyProvider=provider;
    const backend=new SharedWorker('/host-worker/retained'+(denied?'-denied':'')+'.js',{name:'retained-services-'+denied+'-'+type});
    globalThis.retainedBackend=backend;
    await new Promise((resolve,reject)=>{
      backend.onerror=event=>reject(new Error(event.message));backend.port.onmessage=event=>event.data.error?reject(new Error(JSON.stringify(event.data.error))):resolve(event.data);
      backend.port.postMessage({op:'policy',lease:provider.lease,authority:provider.authority},[provider.port]);
    });
  },{denied,type,seed});
}

export async function verify_retained_worker_host(browser,origin){
  const context=await browser.newContext(),results=[];
  try{
    for(const denied of [false,true])for(const type of ['classic','module']){
      const first=await context.newPage();let second=await context.newPage();
      await first.goto(origin+'/host-worker/page');await install_policy_provider(second,origin,denied,type);
      const nativeSurface=await first.evaluate(surface=>new Promise((resolve,reject)=>{
        const source='onconnect=function(event){event.ports[0].postMessage(('+surface+')(event,this));};';
        const worker=new SharedWorker('data:text/javascript,'+encodeURIComponent(source));worker.port.onmessage=event=>resolve(event.data);worker.onerror=event=>reject(new Error(event.message));
      }),worker_surface.toString());
      const profile=await first.evaluate(async({denied,type,authored,surface})=>{
        const runtime=await(await fetch('/host-worker/runtime.js')).text(),nonce=crypto.randomUUID(),id=crypto.randomUUID();
        const bootstrap=`/* ${id} */(()=>{let owner,notifications=0;onconnect=event=>{event.stopImmediatePropagation();if(owner)return;owner=event.ports[0];owner.onmessage=async event=>{if(event.data.audit){owner.postMessage({audit:true,notifications});return;}if(!event.data.init)return;const {runtime,options,nonce}=event.data;const nativeOrigin=origin;event.ports[0].addEventListener('message',event=>{if(event.data?.type==='notification'&&event.data.procedure==='cookies_update')notifications++;});globalThis.__sandstone_bootstrap__={nonce,channels:1};(0,eval)(runtime);let invalidPort,reinitialized;try{sandstone_frame.worker.initialize_shared_worker(options,{},owner,nonce);}catch(error){invalidPort=error.name;}await sandstone_frame.worker.initialize_shared_worker(options,event.ports[0],owner,nonce);try{sandstone_frame.worker.initialize_shared_worker(options,event.ports[0],owner,nonce);}catch(error){reinitialized=error.name;}owner.postMessage({initialized:true,nativeOrigin,invalidPort,reinitialized});};owner.start();};})();`;
        const url='data:text/javascript,'+encodeURIComponent(bootstrap),name='retained-'+id,backendName='retained-services-'+denied+'-'+type;
        const backend=new SharedWorker('/host-worker/retained'+(denied?'-denied':'')+'.js',{name:backendName}),owner=new SharedWorker(url,{name}),host=new MessageChannel();
        const opened=new Promise((resolve,reject)=>{backend.port.onmessage=e=>e.data.error?reject(new Error(JSON.stringify(e.data.error))):resolve(e.data);backend.onerror=e=>reject(new Error(e.message));});
        backend.port.postMessage({id,op:'open',context:{url:location.origin+'/host-worker/remote.js',top_url:'https://other-worker-owner.test/page'}},[host.port1]);
        const openedHost=await opened;
        const initialized=new Promise((resolve,reject)=>{owner.port.onmessage=e=>{if(e.data.initialized)resolve(e.data);else if(e.data.type==='error')reject(new Error(e.data.message));};owner.onerror=e=>reject(new Error(e.message));});
        const source='const useEventListener='+JSON.stringify(type==='module')+';const worker_surface=('+surface+');('+authored+')();'+(type==='module'?'await new Promise(()=>{});':'');
        owner.port.postMessage({init:true,nonce,runtime,options:{...openedHost.profile,source,sources:{[openedHost.profile.url]:source},token:id,type,credentials:'same-origin',runtime_src:runtime,sync_http:false}},[host.port2]);
        const ready=await initialized;globalThis.retainedBackend=backend;globalThis.retainedOwner=owner;
        return {url,name,backendName,id,denied,nativeOrigin:ready.nativeOrigin,invalidPort:ready.invalidPort,reinitialized:ready.reinitialized,persistent:openedHost.persistent};
      },{denied,type,authored:authored_worker.toString(),surface:worker_surface.toString()});
      assert.equal(profile.nativeOrigin,'null');assert.equal(profile.persistent,!denied);
      assert.equal(profile.invalidPort,'TypeError');assert.equal(profile.reinitialized,'InvalidStateError');
      const connect=(page,operation)=>page.evaluate(({profile,operation})=>new Promise((resolve,reject)=>{
        const worker=new SharedWorker(profile.url,{name:profile.name});(globalThis.retainedClients??=[]).push(worker);
        const timer=setTimeout(()=>reject(new Error('Retained runtime reply timed out')),12000);
        worker.onerror=event=>{clearTimeout(timer);reject(new Error(event.message));};
        worker.port.onmessage=event=>{clearTimeout(timer);event.data.error?reject(new Error(JSON.stringify(event.data.error))):resolve(event.data);};worker.port.postMessage(operation);
      }),{profile,operation});
      const firstReply=await connect(first,'write');
      const expected={counter:1,surface:nativeSurface,origin,transport:'relayed host data',cookies:'worker_session=secret; worker_redirect=yes',socket:{origin,session:'secret',blocked:false,protocol:'retained',committed:true,events:['open','metadata','echo','close']},refused:true,signature:firstReply.signature,stored:[17,34,51]};
      assert.equal(firstReply.signature.length,32);assert.deepEqual(firstReply,expected);
      const audit=await first.evaluate(()=>new Promise(resolve=>{retainedOwner.port.onmessage=event=>{if(event.data.audit)resolve(event.data.notifications);};retainedOwner.port.postMessage({audit:true});}));
      assert.equal(audit,0,'The worker received the metadata owner\'s cookies');
      const retained=await first.evaluate(id=>new Promise(resolve=>{retainedBackend.port.onmessage=event=>resolve(event.data);retainedBackend.port.postMessage({id,op:'control'},[retainedOwner.port]);}),profile.id);
      assert.deepEqual(retained,{id:profile.id,retained:true});
      await second.evaluate(({denied,name})=>{globalThis.retainedBackend=new SharedWorker('/host-worker/retained'+(denied?'-denied':'')+'.js',{name});retainedBackend.port.start();},{denied,name:profile.backendName});
      assert.deepEqual(await connect(second,'read'),{...expected,counter:2});
      await first.close();assert.deepEqual(await connect(second,'read'),{...expected,counter:3});
      if(!denied){
        for(const [mode,counter] of [['header',4],['set',5]]){
          const previous=second;second=await context.newPage();await install_policy_provider(second,origin,denied,type,false);
          await previous.evaluate(mode=>{globalThis.policyHeld=null;globalThis[mode==='header'?'policyHoldHeader':'policyHoldSet']=true;},mode);
          const pending=connect(second,'read');
          await previous.waitForFunction(()=>globalThis.policyHeld);
          const held=await previous.evaluate(()=>globalThis.policyHeld);await previous.close();
          assert.deepEqual(await pending,{...expected,counter});
          if(mode==='set')assert.equal(await second.evaluate(cookie=>sandstone.controller.site_data.persistence.cookieVersion(cookie).version,held.cookie),held.version,'Handoff replayed a committed cookie write');
        }
        results.push('Opaque '+type+' worker policy calls survive provider death before a cookie read and after an unacknowledged write');
      }
      await second.evaluate(()=>{
        const port=retainedClients.at(-1).port;
        globalThis.retainedClearResult=new Promise(resolve=>{port.onmessage=event=>resolve(event.data);});port.postMessage('hold');
      });
      await second.waitForFunction(async()=>await(await fetch('/host-worker/cookie-status')).json()===1);
      const cleared=await second.evaluate(async()=>{
        const store=sandstone.controller.site_data;store.clear(location.hostname,{cookies:true,localStorage:false});
        store.setCookie(location.origin,'fresh=after; HttpOnly; SameSite=None; Secure; Path=/',true);
        await fetch('/host-worker/cookie-release');return await retainedClearResult;
      });
      assert.deepEqual(cleared,{clearedCookies:'fresh=after'});
      await second.evaluate(()=>{
        const port=retainedClients.at(-1).port;
        globalThis.retainedSocketClearResult=new Promise(resolve=>{port.onmessage=event=>resolve(event.data);});port.postMessage('hold-socket');
      });
      await second.waitForFunction(async()=>await(await fetch('/host-worker/socket-status')).json()===1);
      const socketCleared=await second.evaluate(async()=>{
        const store=sandstone.controller.site_data;store.clear(location.hostname,{cookies:true,localStorage:false});
        store.setCookie(location.origin,'fresh=newer; HttpOnly; SameSite=None; Secure; Path=/',true);
        await fetch('/host-worker/socket-release');return await retainedSocketClearResult;
      });
      assert.deepEqual(socketCleared,{clearedSocketCookies:'fresh=newer'});
      const closed=await second.evaluate(id=>new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Retained worker close report timed out')),10000);
        retainedBackend.port.onmessage=event=>{clearTimeout(timer);resolve(event.data);};retainedBackend.port.postMessage({id,op:'watch-close'});
        retainedClients.at(-1).port.postMessage('close');
      }),profile.id);
      assert.deepEqual(closed,{id:profile.id,frames:0});await second.close();
      results.push('Opaque '+type+' worker scope, authenticated HTTP/WebSockets, cookie clearing, nonextractable keys and '+(denied?'memory':'durable')+' IndexedDB survive their creating window');
    }
    return results;
  }finally{await context.close();}
}
