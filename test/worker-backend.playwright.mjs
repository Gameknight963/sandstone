import assert from 'node:assert/strict';

export async function verify_worker_backend(browser,origin){
  const context=await browser.newContext();
  const load=async()=>{
    const page=await context.newPage();await page.goto(origin+'/host-worker/page');
    await page.addScriptTag({url:origin+'/host-worker/bundle.js'});return page;
  };
  try{
    const first=await load(),second=await load(),websocket=origin.replace(/^http/,'ws')+'/';
    const descriptor=await first.evaluate(async websocket=>{
      globalThis.backend=await sandstone.worker_backends.create({websocket});
      return {url:backend.url,name:backend.name,identity:backend.identity,websocket};
    },websocket);
    assert.ok(descriptor.url.startsWith('blob:'+origin+'/'));
    const opened=await second.evaluate(async descriptor=>{
      globalThis.backend=await sandstone.worker_backends.connect(descriptor.url,descriptor);
      const store=sandstone.controller.site_data;await store.ready;
      store.setCookie(location.origin,'backend_session=secret; HttpOnly; Path=/');
      globalThis.provider=await sandstone.create_policy_provider(sandstone.cookie_policy_handler(store),{authority:()=>store.cookiePolicyAuthority()});
      await backend.request('policy',{lease:provider.lease,authority:provider.authority},[provider.port]);
      const channel=new MessageChannel();
      globalThis.service=await backend.request('open',{context:{url:location.origin+'/host-worker/remote.js'}},[channel.port1]);
      let sequence=0;const pending=new Map();
      channel.port2.onmessage=event=>{
        const reply=event.data;if(reply.type!=='reply')return;
        const call=pending.get(reply.id);if(!call)return;pending.delete(reply.id);
        reply.content.success?call.resolve(reply.content.value):call.reject(reply.content.value);
      };channel.port2.start();
      globalThis.callService=(procedure,args)=>new Promise((resolve,reject)=>{
        const id=String(++sequence);pending.set(id,{resolve,reject});
        channel.port2.postMessage({type:'procedure',id,procedure,arguments:args});
      });
      globalThis.readService=async()=>{
        const id=service.profile.frame_id,request=crypto.randomUUID();
        const response=await callService('fetch',[id,request,location.origin+'/host-worker/cookie-end',{credentials:'include',mode:'same-origin'}]);
        let text='';const decoder=new TextDecoder();
        for(;;){const chunk=await callService('fetch_read',[id,request]);if(chunk.done)break;text+=decoder.decode(chunk.value,{stream:true});}
        text+=decoder.decode();return {text,cookies:response.cookies,status:response.items.status};
      };
      return {identity:backend.identity,service:service.id,persistent:backend.persistent};
    },descriptor);
    assert.equal(opened.identity,descriptor.identity);assert.equal(opened.persistent,true);
    const initial=await second.evaluate(()=>readService());
    assert.equal(initial.text,'backend_session=secret');assert.equal(initial.status,200);assert.equal(initial.cookies,undefined);
    await first.close();
    assert.deepEqual(await second.evaluate(()=>readService()),initial);
    const third=await load();
    assert.equal(await third.evaluate(async descriptor=>{
      globalThis.backend=await sandstone.worker_backends.connect(descriptor.url,descriptor);return backend.identity;
    },descriptor),descriptor.identity);
    const refused=await third.evaluate(async descriptor=>{
      try{await sandstone.worker_backends.connect(descriptor.url,{...descriptor,websocket:descriptor.websocket+'different'});return 'accepted';}
      catch(error){return error.name;}
    },descriptor);
    assert.equal(refused,'InvalidStateError');assert.deepEqual(await second.evaluate(()=>readService()),initial);
    const restrictions=await second.evaluate(async()=>{
      const names=[];
      for(const [procedure,args] of [['crypto',['forged-frame','digest',['SHA-256',new Uint8Array()]]],['navigate',[service.profile.frame_id,'https://elsewhere.test/']]]){
        try{await callService(procedure,args);names.push('accepted');}catch(error){names.push(error.name);}
      }
      const digest=await callService('crypto',[service.profile.frame_id,'digest',['SHA-256',new Uint8Array([1,2,3])]]);
      return {names,digest:[...new Uint8Array(digest)]};
    });
    assert.deepEqual(restrictions.names,['SecurityError','SecurityError']);
    assert.deepEqual(restrictions.digest,[3,144,88,198,242,192,203,73,44,83,59,10,77,20,239,119,204,15,120,171,204,206,213,40,125,132,161,162,1,28,251,129]);
    assert.equal(await third.evaluate(id=>backend.request('close',{worker:id}),opened.service),true);
    assert.equal(await second.evaluate(()=>backend.request('close',{worker:service.id})),false);
    await second.evaluate(()=>{provider.close();backend.close();});await third.evaluate(()=>backend.close());
    return ['Embedded trusted worker backend needs no separately hosted script','Worker backend survives creator closure and reconnects through its private blob URL','Retained backend relays cookies and crypto while rejecting forged renderer requests','Worker backend rejects relay configuration changes without disturbing live clients'];
  }finally{await context.close();}
}
