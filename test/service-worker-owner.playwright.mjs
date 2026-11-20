import assert from 'node:assert/strict';
import {once} from 'node:events';

export async function verifyServiceWorkerOwner(page){
  const visible=await(await page.locator('iframe[frame-id]').elementHandle()).contentFrame();
  assert.equal(await visible.evaluate(()=>{try{sandstone_frame.rpc.rpc_handlers.service_worker_control('close');return 'allowed';}catch(error){return error.name;}}),'SecurityError');
  const before=new Set(page.workers());
  const result=await page.evaluate(async()=>{
    const origin='https://service-worker-owner.test';
    main_frame.on_load=()=>{};
    main_frame.special_pages[origin+'/client']='<!doctype html><body>Original client';
    await main_frame.navigate_to(origin+'/client');
    const commands=[];
    const source=`let controller,release;
      oninstall=event=>event.waitUntil(skipWaiting());
      onfetch=event=>{
        const gate=new Promise(resolve=>release=resolve);
        event.waitUntil(Promise.all([gate,event.handled]));
        event.respondWith(new Response(new ReadableStream({start(value){controller=value;value.enqueue(Uint8Array.of(41));}})));
      };
      onmessage=event=>{if(event.data==='finish'){controller.enqueue(Uint8Array.of(42));controller.close();release();}};`;
    const owner=await sandstone.service_workers.create_service_worker_driver({scriptURL:origin+'/worker.js',scope:origin+'/',source},{command:async method=>{commands.push(method);}});
    globalThis.testServiceWorkerOwner=owner;
    const install=owner.dispatch({event:'install'});await install.result;await install.lifetime;await install.release();
    const job=owner.dispatch({event:'fetch',request:{url:origin+'/stream'}});globalThis.testServiceWorkerFetch=job;
    const response=await job.result;await job.handled();
    const first=await job.read();
    const beforeNavigation={visible:document.querySelectorAll('iframe[frame-id]').length,owners:document.querySelectorAll('iframe[data-service-worker-owner]').length};
    main_frame.special_pages['https://another-client.test/page']='<!doctype html><body>Replacement client';
    await main_frame.navigate_to('https://another-client.test/page');
    const next=job.read();
    const message=owner.dispatch({event:'message',origin:'https://another-client.test',data:'finish'});await message.result;await message.lifetime;await message.release();
    const second=await next,last=await job.read();await job.lifetime;await job.release();
    return {commands,beforeNavigation,status:response.metadata.status,first:[...first.value],second:[...second.value],last:last.done,visibleURL:main_frame.url.href};
  });
  assert.deepEqual(result,{commands:['skipWaiting'],beforeNavigation:{visible:1,owners:1},status:200,first:[41],second:[42],last:true,visibleURL:'https://another-client.test/page'});
  const ownedWorkers=page.workers().filter(worker=>!before.has(worker));
  assert.ok(ownedWorkers.length>0,'The owner must create an actual dedicated worker');
  const closed=ownedWorkers.map(worker=>once(worker,'close'));
  const cleanup=await page.evaluate(async()=>{
    const owner=testServiceWorkerOwner;
    const job=owner.dispatch({event:'fetch',request:{url:owner.profile.origin+'/pending'}});await job.result;
    const pending=job.read().then(()=>null,error=>error.name);
    owner.close();owner.close();
    const rejection=await pending;
    const registered=Object.values(sandstone.controller.iframes).some(frame=>frame.root_id===owner.frame.id);
    delete globalThis.testServiceWorkerOwner;delete globalThis.testServiceWorkerFetch;
    return {rejection,registered,owners:document.querySelectorAll('iframe[data-service-worker-owner]').length};
  });
  assert.deepEqual(cleanup,{rejection:'AbortError',registered:false,owners:0});
  let timer;
  try{await Promise.race([Promise.all(closed),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owner removal did not terminate its native worker')),10000);})]);}
  finally{clearTimeout(timer);}
  return ['A host-owned service worker keeps its response stream and background event alive across cross-origin client navigation','Closing the owner aborts pending reads, removes its frame registrations and terminates its actual worker'];
}
