import assert from 'node:assert/strict';

export async function verifyServiceWorkerStorage(page,{storageDenied=false}={}){
  const fixture=await page.context().newPage(),origin='https://service-worker-storage.test';
  const errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
  try{
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.evaluate(async origin=>{
      const storage=sandstone.service_workers.registrations;await storage.clear(new URL(origin).hostname);
      const state={scope:origin+'/',updateViaCache:'imports',active:{id:'one',scriptURL:origin+'/worker.js',type:'classic',source:'self.value=41;',scripts:[{url:'https://cdn.test/runtime.js',source:'self.imported=42;',headers:[['content-type','text/javascript']]}]}};
      await storage.commit(await storage.begin(origin),state,0);
    },origin);
    await fixture.reload();await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    const restored=await fixture.evaluate(async origin=>{
      const storage=sandstone.service_workers.registrations,values=await storage.list(origin);
      return {persistent:storage.persistent,count:values.length,source:values[0]?.state.active.scripts[0].source||null};
    },origin);
    assert.deepEqual(restored,storageDenied?{persistent:false,count:0,source:null}:{persistent:true,count:1,source:'self.imported=42;'});
    await fixture.evaluate(async origin=>{
      main_frame.on_load=()=>{};main_frame.special_pages[origin+'/client']='<!doctype html><body>Worker client';
      await main_frame.navigate_to(origin+'/client');
      const storage=sandstone.service_workers.registrations,ticket=await storage.begin(origin),existing=await storage.read(origin,origin+'/');
      const state={scope:origin+'/',active:{id:'one',scriptURL:origin+'/worker.js',type:'classic',source:'self.value=41;'}};
      if(!existing.state)await storage.commit(ticket,state,existing.revision);
      globalThis.staleWorkerInstall={ticket,state};
      sandstone.controller.site_data.setLocal(origin,[['kept','yes']]);
      const foreign='https://another-worker-storage.test',value={scope:foreign+'/',active:{id:'foreign',scriptURL:foreign+'/worker.js',source:''}};
      await storage.clear(new URL(foreign).hostname);await storage.commit(await storage.begin(foreign),value,0);
      const source='onfetch=event=>{event.waitUntil(new Promise(()=>{}));event.respondWith(new Response(new ReadableStream({start(controller){controller.enqueue(Uint8Array.of(41));}})))};';
      globalThis.storageWorkerOwner=await sandstone.service_workers.create_service_worker_driver({scriptURL:origin+'/worker.js',scope:origin+'/',source});
      const job=storageWorkerOwner.dispatch({event:'fetch',request:{url:origin+'/held'}});await job.result;await job.read();
      globalThis.storageWorkerRead=job.read().then(()=>null,error=>error.name);
    },origin);
    await fixture.locator('#options_button').click();
    await fixture.locator('#site_data_details').evaluate(element=>element.open=true);
    const row=fixture.locator('.site_data_row').filter({hasText:'service-worker-storage.test:'}).filter({hasNotText:'another-worker-storage.test:'});
    await row.getByText(/1 service workers/).waitFor();
    await row.getByRole('button',{name:'Clear service workers',exact:true}).click();
    await row.getByText(/0 service workers/).waitFor();
    await fixture.waitForFunction(origin=>!main_frame.is_navigating&&main_frame.url?.href===origin+'/client',origin);
    const cleared=await fixture.evaluate(async origin=>{
      const storage=sandstone.service_workers.registrations;let stale;
      try{await storage.commit(staleWorkerInstall.ticket,staleWorkerInstall.state,0);stale='committed';}catch(error){stale=error.name;}
      return {stale,workers:(await storage.list(origin)).length,foreign:(await storage.list('https://another-worker-storage.test')).length,
        local:sandstone.controller.site_data.local[origin],read:await storageWorkerRead,owners:document.querySelectorAll('iframe[data-service-worker-owner]').length};
    },origin);
    assert.deepEqual(cleared,{stale:'AbortError',workers:0,foreign:1,local:[['kept','yes']],read:'AbortError',owners:0});
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Installed service worker sources persist across standalone reloads when storage is available','Per-site worker clearing stops live owners, rejects stale installs and preserves other site data'];
  }finally{
    await fixture.evaluate(async origin=>{await sandstone.service_workers.clear_registrations(new URL(origin).hostname);await sandstone.service_workers.clear_registrations('another-worker-storage.test');}).catch(()=>{});
    await fixture.close();
  }
}
