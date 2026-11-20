import assert from 'node:assert/strict';

export async function verifyServiceWorkerManager(page,{storageDenied=false}={}){
  const fixture=await page.context().newPage(),origin='https://managed-worker.test',errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
  try{
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    const initial=await fixture.evaluate(async origin=>{
      const {manager}=sandstone.service_workers;await sandstone.service_workers.clear_registrations(new URL(origin).hostname);
      globalThis.lifecycleDependency=1;globalThis.lifecycleHold=true;globalThis.lifecycleGateStarted=false;globalThis.lifecycleRequests=[];
      const source=`importScripts('./dependency.js');
        oninstall=event=>event.waitUntil((async()=>{
          await fetch('./install-gate');if(dependency===3)throw new Error('rejected install');
          const cache=await caches.open('lifecycle');await cache.put('./version',new Response(String(dependency)));
        })());
        onactivate=event=>event.waitUntil((async()=>{
          await clients.claim();const result=await registration.update();
          const cache=await caches.open('lifecycle');await cache.put('./updated',new Response(String(result===registration)));
          if(dependency===5)throw new Error('activation cleanup failed');
        })());
        onmessage=event=>{
          if(event.data==='skip'){event.waitUntil(skipWaiting());return;}
          event.waitUntil((async()=>{const cache=await caches.open('lifecycle');event.ports[0].postMessage({dependency,cached:await(await cache.match('./version')).text(),updated:await(await cache.match('./updated')).text()})})());
        };`;
      sandstone.network.session.fetch=async(url,options)=>{
        lifecycleRequests.push(url);const path=new URL(url).pathname;
        if(path==='/install-gate'&&lifecycleHold){lifecycleGateStarted=true;await new Promise(resolve=>globalThis.lifecycleRelease=resolve);}
        return new Response(path==='/worker.js'?source:path==='/dependency.js'?'self.dependency='+lifecycleDependency+';':'ready',{headers:{'content-type':path.endsWith('.js')?'text/javascript':'text/plain','cache-control':'no-store'}});
      };
      globalThis.lifecycleClient=manager.addClient({id:'lifecycle-client',url:origin+'/page'});
      globalThis.lifecycleRecord=await manager.register(origin+'/worker.js',{}, {base:origin+'/page',origin});
      return {state:lifecycleRecord.installing.state,active:lifecycleRecord.active,persisted:(await sandstone.service_workers.registrations.list(origin)).length};
    },origin);
    assert.deepEqual(initial,{state:'installing',active:null,persisted:0});
    await fixture.waitForFunction(()=>lifecycleGateStarted);
    const activated=await fixture.evaluate(async()=>{
      lifecycleHold=false;lifecycleRelease();const manager=sandstone.service_workers.manager;await manager.settled(lifecycleRecord);
      const owner=lifecycleRecord.active.owner;
      const channel=new MessageChannel(),reply=new Promise(resolve=>channel.port1.onmessage=event=>resolve(event.data));
      const job=await manager.dispatch(lifecycleRecord,lifecycleRecord.active,{event:'message',data:'report',ports:[channel.port2]});await job.result;await job.lifetime;
      const value=await reply;channel.port1.close();globalThis.lifecycleOriginal=lifecycleRecord.active;
      return {state:lifecycleRecord.active.state,claimed:lifecycleClient.controller===lifecycleRecord.active,value};
    });
    assert.deepEqual(activated,{state:'activated',claimed:true,value:{dependency:1,cached:'1',updated:'true'}});
    const waiting=await fixture.evaluate(async origin=>{
      lifecycleDependency=2;const manager=sandstone.service_workers.manager;
      await manager.register(origin+'/worker.js',{}, {base:origin+'/page',origin});await manager.settled(lifecycleRecord);
      const saved=await sandstone.service_workers.registrations.read(origin,origin+'/');
      return {active:lifecycleRecord.active===lifecycleOriginal,waiting:lifecycleRecord.waiting.state,savedActive:saved.state.active.id===lifecycleOriginal.id,savedWaiting:saved.state.waiting.id===lifecycleRecord.waiting.id};
    },origin);
    assert.deepEqual(waiting,{active:true,waiting:'installed',savedActive:true,savedWaiting:true});
    const replaced=await fixture.evaluate(async()=>{
      const manager=sandstone.service_workers.manager,job=await manager.dispatch(lifecycleRecord,lifecycleRecord.waiting,{event:'message',data:'skip'});await job.result;await job.lifetime;await manager.settled(lifecycleRecord);
      globalThis.lifecycleSecond=lifecycleRecord.active;
      return {state:lifecycleSecond.state,replaced:lifecycleSecond!==lifecycleOriginal,old:lifecycleOriginal.state,claimed:lifecycleClient.controller===lifecycleSecond};
    });
    assert.deepEqual(replaced,{state:'activated',replaced:true,old:'redundant',claimed:true});
    const failure=await fixture.evaluate(async origin=>{
      lifecycleDependency=3;const manager=sandstone.service_workers.manager;
      await manager.register(origin+'/worker.js',{}, {base:origin+'/page',origin});let error;
      try{await manager.settled(lifecycleRecord);}catch(value){error=value.message;}
      const saved=await sandstone.service_workers.registrations.read(origin,origin+'/');
      return {error,active:lifecycleRecord.active===lifecycleSecond,claimed:lifecycleClient.controller===lifecycleSecond,persisted:saved.state.active.id===lifecycleSecond.id};
    },origin);
    assert.deepEqual(failure,{error:'rejected install',active:true,claimed:true,persisted:true});
    await fixture.evaluate(async origin=>{
      lifecycleDependency=4;lifecycleHold=true;lifecycleGateStarted=false;
      const manager=sandstone.service_workers.manager;await manager.register(origin+'/worker.js',{}, {base:origin+'/page',origin});
    },origin);
    await fixture.waitForFunction(()=>lifecycleGateStarted);
    const cleared=await fixture.evaluate(async origin=>{
      const manager=sandstone.service_workers.manager,settled=manager.settled(lifecycleRecord).then(()=>null,error=>error.name);
      await sandstone.service_workers.clear_registrations(new URL(origin).hostname);lifecycleHold=false;lifecycleRelease();
      return {error:await settled,stored:(await sandstone.service_workers.registrations.list(origin)).length,controller:lifecycleClient.controller,owners:document.querySelectorAll('iframe[data-service-worker-owner]').length};
    },origin);
    assert.deepEqual(cleared,{error:'AbortError',stored:0,controller:null,owners:0});
    const cleanupFailure=await fixture.evaluate(async origin=>{
      lifecycleDependency=5;const manager=sandstone.service_workers.manager;
      const record=await manager.register(origin+'/worker.js',{}, {base:origin+'/page',origin});await manager.settled(record);
      return {state:record.active.state,error:record.active.activationError?.message};
    },origin);
    assert.deepEqual(cleanupFailure,{state:'activated',error:'activation cleanup failed'});
    await fixture.reload();await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    const resumed=await fixture.evaluate(async origin=>{
      const requests=[];sandstone.network.session.fetch=async url=>{requests.push(url);throw new TypeError('Offline');};
      const manager=sandstone.service_workers.manager,record=await manager.get(origin,origin+'/#fragment');
      if(!record)return {registered:false,requests};
      const channel=new MessageChannel(),reply=new Promise(resolve=>channel.port1.onmessage=event=>resolve(event.data));
      const job=await manager.dispatch(record,record.active,{event:'message',data:'report',ports:[channel.port2]});await job.result;await job.lifetime;
      const value=await reply;channel.port1.close();return {registered:true,state:record.active.state,value,requests};
    },origin);
    assert.deepEqual(resumed,storageDenied?{registered:false,requests:[]}:{registered:true,state:'activated',value:{dependency:5,cached:'5',updated:'true'},requests:[]});
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Registration resolves during install while waitUntil holds activation and persistence','Real worker install/activate handlers cache data, claim clients and update without deadlocking','Import changes wait for clients and skipWaiting replaces the controller','Failed installs preserve the active worker; clearing aborts candidates without resurrection','Activation cleanup failures retain an activated worker','Durable active registrations restart offline without repeating installation or activation'];
  }finally{
    await fixture.evaluate(async origin=>{await sandstone.service_workers.clear_registrations(new URL(origin).hostname);sandstone.service_workers.manager.removeClient('lifecycle-client');}).catch(()=>{});
    await fixture.close();
  }
}
