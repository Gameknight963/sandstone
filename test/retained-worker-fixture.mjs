import assert from 'node:assert/strict';

export function retained_worker_main(){
  const hosts=new Map();
  onconnect=event=>{
    const port=event.ports[0];
    port.onmessage=async event=>{
      const {id,op,context}=event.data;
      try{
        if(op==='open'){
          await sandstone.controller.indexed_db.ready;await sandstone.libcurl.load_wasm();
          sandstone.network.set_websocket(location.origin.replace(/^http/,'ws')+'/');
          const host=new sandstone.WorkerServiceHost(context,event.ports[0]);hosts.set(id,host);
          sandstone.controller.site_data.setCookie(context.top_url,'owner-only=secret; Path=/');
          port.postMessage({id,profile:host.profile,persistent:sandstone.controller.indexed_db.persistent});
        }else if(op==='close'){
          hosts.get(id)?.close();hosts.delete(id);
          port.postMessage({id,frames:Object.keys(sandstone.controller.iframes).length});
        }
      }catch(error){port.postMessage({id,error:{name:error.name,message:error.message,stack:error.stack}});}
    };port.start();
  };
}

function authored_worker(){
  let counter=0;
  const key=crypto.subtle.generateKey({name:'HMAC',hash:'SHA-256'},false,['sign']);
  const open=()=>new Promise((resolve,reject)=>{
    const request=indexedDB.open('retained-worker',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('values');
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  onconnect=event=>{
    const port=event.ports[0];port.onmessage=async event=>{
      try{
        const transport=await(await fetch('./data',{credentials:'omit'})).text();
        const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',await key,new Uint8Array([4,5,6]))));
        const db=await open();let value;
        await new Promise((resolve,reject)=>{
          const tx=db.transaction('values',event.data==='write'?'readwrite':'readonly'),store=tx.objectStore('values');
          if(event.data==='write')store.put(new Uint8Array([17,34,51]),'saved');
          const request=store.get('saved');request.onsuccess=()=>value=request.result;
          tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
        });db.close();
        port.postMessage({counter:++counter,scope:Object.prototype.toString.call(self),origin,transport,signature,stored:value?[...value]:null});
      }catch(error){port.postMessage({error:{name:error.name,message:error.message,stack:error.stack}});}
    };port.start();
  };
}

export async function verify_retained_worker_host(browser,origin){
  const context=await browser.newContext(),results=[];
  try{
    for(const denied of [false,true]){
      const first=await context.newPage(),second=await context.newPage();
      await first.goto(origin+'/host-worker/page');await second.goto(origin+'/host-worker/page');
      const profile=await first.evaluate(async({denied,authored})=>{
        const runtime=await(await fetch('/host-worker/runtime.js')).text(),nonce=crypto.randomUUID(),id=crypto.randomUUID();
        const bootstrap=`/* ${id} */let owner,notifications=0;onconnect=event=>{event.stopImmediatePropagation();if(owner)return;owner=event.ports[0];owner.onmessage=event=>{if(event.data.audit){owner.postMessage({audit:true,notifications});return;}if(!event.data.init)return;const {runtime,options,nonce}=event.data;const nativeOrigin=origin;event.ports[0].addEventListener('message',event=>{if(event.data?.type==='notification'&&event.data.procedure==='cookies_update')notifications++;});globalThis.postMessage=(value,transfer)=>owner.postMessage(value,transfer);globalThis.__sandstone_bootstrap__={nonce,channels:1};(0,eval)(runtime);sandstone_frame.worker.initialize_worker(options);sandstone_frame.rpc.connect_frame_host(event.ports[0],nonce);dispatchEvent(new MessageEvent('message',{data:{sandstone_worker:options.token,type:'connect'},ports:[event.ports[1]]}));owner.postMessage({initialized:true,nativeOrigin});};owner.start();};`;
        const url='data:text/javascript,'+encodeURIComponent(bootstrap),name='retained-'+id,backendName='retained-services-'+denied;
        const backend=new SharedWorker('/host-worker/retained'+(denied?'-denied':'')+'.js',{name:backendName}),owner=new SharedWorker(url,{name}),host=new MessageChannel(),app=new MessageChannel();
        const opened=new Promise((resolve,reject)=>{backend.port.onmessage=e=>e.data.error?reject(new Error(JSON.stringify(e.data.error))):resolve(e.data);backend.onerror=e=>reject(new Error(e.message));});
        backend.port.postMessage({id,op:'open',context:{url:location.origin+'/host-worker/remote.js',top_url:'https://other-worker-owner.test/page'}},[host.port1]);
        const openedHost=await opened;
        const initialized=new Promise((resolve,reject)=>{owner.port.onmessage=e=>{if(e.data.initialized)resolve(e.data);else if(e.data.type==='error')reject(new Error(e.data.message));};owner.onerror=e=>reject(new Error(e.message));});
        const source='('+authored+')();';
        owner.port.postMessage({init:true,nonce,runtime,options:{...openedHost.profile,source,sources:{[openedHost.profile.url]:source},token:id,type:'classic',credentials:'same-origin',runtime_src:runtime,sync_http:false}},[host.port2,app.port2]);
        const ready=await initialized;globalThis.retainedBackend=backend;globalThis.retainedOwner=owner;globalThis.retainedApp=app;
        return {url,name,backendName,id,denied,nativeOrigin:ready.nativeOrigin,persistent:openedHost.persistent};
      },{denied,authored:authored_worker.toString()});
      assert.equal(profile.nativeOrigin,'null');assert.equal(profile.persistent,!denied);
      const connect=(page,operation)=>page.evaluate(({profile,operation})=>new Promise((resolve,reject)=>{
        const worker=new SharedWorker(profile.url,{name:profile.name});(globalThis.retainedClients??=[]).push(worker);
        const timer=setTimeout(()=>reject(new Error('Retained runtime reply timed out')),12000);
        worker.onerror=event=>{clearTimeout(timer);reject(new Error(event.message));};
        worker.port.onmessage=event=>{clearTimeout(timer);event.data.error?reject(new Error(JSON.stringify(event.data.error))):resolve(event.data);};worker.port.postMessage(operation);
      }),{profile,operation});
      const firstReply=await connect(first,'write');
      const expected={counter:1,scope:'[object SharedWorkerGlobalScope]',origin,transport:'relayed host data',signature:firstReply.signature,stored:[17,34,51]};
      assert.equal(firstReply.signature.length,32);assert.deepEqual(firstReply,expected);
      const audit=await first.evaluate(()=>new Promise(resolve=>{retainedOwner.port.onmessage=event=>{if(event.data.audit)resolve(event.data.notifications);};retainedOwner.port.postMessage({audit:true});}));
      assert.equal(audit,0,'The worker received the metadata owner\'s cookies');
      await second.evaluate(({denied,name})=>{globalThis.retainedBackend=new SharedWorker('/host-worker/retained'+(denied?'-denied':'')+'.js',{name});retainedBackend.port.start();},{denied,name:profile.backendName});
      assert.deepEqual(await connect(second,'read'),{...expected,counter:2});
      await first.close();assert.deepEqual(await connect(second,'read'),{...expected,counter:3});
      const closed=await second.evaluate(id=>new Promise(resolve=>{retainedBackend.port.onmessage=event=>resolve(event.data);retainedBackend.port.postMessage({id,op:'close'});}),profile.id);
      assert.deepEqual(closed,{id:profile.id,frames:0});await second.close();
      results.push('Opaque worker relay, nonextractable keys and '+(denied?'memory':'durable')+' IndexedDB survive their creating window');
    }
    return results;
  }finally{await context.close();}
}
