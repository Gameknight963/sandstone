import assert from 'node:assert/strict';
import {wait_for} from './wait-for.mjs';

export async function verify_worker_preparation(browser,origin,fixture){
  const passed=[];
  for(const denied of [false,true]){
    const context=await browser.newContext(),deadline=setTimeout(()=>context.close().catch(()=>{}),45000),direct=[];
    const load=async()=>{
      const page=await context.newPage();await page.goto(origin+'/host-worker/page');
      if(denied)await page.evaluate(()=>{for(const key of ['localStorage','indexedDB','caches'])Object.defineProperty(globalThis,key,{get(){throw new DOMException('Storage denied','SecurityError');}});});
      await page.addScriptTag({url:origin+'/host-worker/bundle.js'});
      page.on('request',request=>{if(/\/host-worker\/prepare/.test(request.url()))direct.push(request.url());});
      await page.evaluate(async origin=>{
        const data=sandstone.controller.site_data;await data.ready;
        globalThis.authority=data.cookiePolicyAuthority();globalThis.backend=await sandstone.worker_backends.get({websocket:origin.replace(/^http/,'ws')+'/'});
        globalThis.provider=await sandstone.create_policy_provider(sandstone.cookie_policy_handler(data),{authority:()=>data.cookiePolicyAuthority()});
        await backend.request('policy',{lease:provider.lease,authority:provider.authority},[provider.port]);
        await sandstone.worker_backends.register_owners(backend);
        globalThis.take=port=>new Promise(resolve=>{port.onmessage=event=>{port.onmessage=null;resolve(event.data);};});
      },origin);return page;
    };
    try{
      const first=await load(),begin=fixture.preparationRequests.length;
      const result=await first.evaluate(async origin=>{
        sandstone.controller.site_data.setCookie(origin+'/','prepare_before=present; SameSite=Strict; Path=/');
        const descriptor={storage_key:origin,url:origin+'/host-worker/prepare-entry.js',secure_context:true,options:{name:'prepared'}};
        globalThis.control=await backend.request('actor-acquire',{document:'prepare',descriptor});control.port=control.ports[0];control.hello=await take(control.port);
        const channel=new MessageChannel();globalThis.service=await backend.request('open',{context:{url:descriptor.url,creator_url:origin+'/host-worker/creator?private=yes',referrer_policy:'no-referrer',cookie_authority:authority}},[channel.port1]);
        const options={local_sources:{'blob:null/prepared-local':{source:new Blob(['globalThis.preparedLocal="captured";'],{type:'text/javascript'})}}};
        const [prepared,again]=await Promise.all([backend.request('prepare',{worker:service.id,options}),backend.request('prepare',{worker:service.id,options})]);
        const runtime=await(await fetch('/host-worker/runtime.js')).text();
        const ready=new Promise((resolve,reject)=>{control.port.onmessage=event=>{if(event.data.type==='ready')resolve();else if(event.data.type==='error'||event.data.type==='scope-error')reject(new Error(event.data.message));};});
        control.port.postMessage({sandstone_actor:control.profile.nonce,instance:control.hello.instance,type:'initialize',runtime,options:{...prepared.profile,...prepared.scripts,runtime_src:runtime,sync_http:false}},[channel.port2]);await ready;
        const client=await backend.request('actor-acquire',{document:'client',descriptor}),port=client.ports[0];await take(port);
        const received=take(port);port.postMessage('inspect');const value=await received;
        const missing=take(port);port.postMessage('missing');const missingResult=await missing;port.close();
        return {profile:prepared.profile,scripts:prepared.scripts,same:prepared.scripts.source===again.scripts.source,value,missing:missingResult};
      },origin);
      assert.equal(result.same,true);assert.equal(result.profile.url,origin+'/host-worker/prepared/entry.js');
      assert.deepEqual(result.missing,{missing:'NetworkError'});
      assert.equal(result.scripts.sources[origin+'/host-worker/prepare-failed.js'],false);
      assert.deepEqual({url:result.value.url,origin:result.value.origin,dependency:result.value.dependency,local:result.value.local,protocol:result.value.protocol},
        {url:result.profile.url,origin,dependency:'relayed',local:'captured',protocol:'retained'});
      assert.ok(result.value.headers.cookie.includes('prepare_before=present'));assert.ok(result.value.headers.cookie.includes('prepare_after=visible'));
      assert.equal(result.value.headers.referer,origin+'/');assert.equal(result.value.headers['sec-fetch-site'],'same-origin');
      const requests=fixture.preparationRequests.slice(begin),entry=requests.find(value=>value.path==='/host-worker/prepare-entry.js'),dependency=requests.find(value=>value.path==='/host-worker/prepared/dependency.js');
      assert.equal(requests.filter(value=>value.path==='/host-worker/prepare-entry.js').length,1);assert.equal(entry.headers['sec-fetch-dest'],'sharedworker');assert.equal(entry.headers.referer,undefined);
      assert.equal(dependency.headers['sec-fetch-dest'],'script');assert.equal(dependency.headers.referer,origin+'/');assert.ok(dependency.headers.cookie.includes('prepare_after=visible'));
      await first.evaluate(async()=>{await backend.request('actor-close',{worker:control.id});await backend.request('close',{worker:service.id});});
      const modules=await first.evaluate(async origin=>{
        const channel=new MessageChannel(),host=await backend.request('open',{context:{url:origin+'/host-worker/prepare-module.js'}},[channel.port1]);
        try{return await backend.request('prepare',{worker:host.id,options:{options:{type:'module',credentials:'omit'}}});}
        finally{channel.port2.close();await backend.request('close',{worker:host.id});}
      },origin);
      assert.equal(modules.scripts.type,'module');assert.equal(Object.keys(modules.scripts.sources).length,1);assert.equal(fixture.preparationRequests.some(value=>value.path==='/host-worker/prepare-never.js'),false);
      assert.equal(fixture.preparationRequests.filter(value=>value.path==='/host-worker/prepare-module.js').at(-1).headers.cookie,undefined);
      const survivor=await load();
      await first.evaluate(async origin=>{const channel=new MessageChannel();globalThis.held=await backend.request('open',{context:{url:origin+'/host-worker/prepare-held.js',creator_url:origin+'/host-worker/original-creator'}},[channel.port1]);globalThis.preparing=backend.request('prepare',{worker:held.id,options:{options:{type:'module',credentials:'omit'}}});preparing.catch(()=>{});},origin);
      await wait_for(()=>fixture.heldPreparations.size===1);
      assert.equal(fixture.preparationRequests.filter(value=>value.path==='/host-worker/prepare-held.js').at(-1).headers.referer,origin+'/host-worker/original-creator');
      const held=await first.evaluate(()=>held.id),oldAuthority=await first.evaluate(()=>authority);await first.close();fixture.releasePreparations();
      const recovered=await survivor.evaluate(worker=>backend.request('prepare',{worker,options:{options:{type:'module',credentials:'omit'}}}),held);
      assert.equal(recovered.scripts.source,'export const prepared=true;');assert.equal(recovered.profile.url,origin+'/host-worker/prepare-held.js');
      await survivor.evaluate(worker=>backend.request('close',{worker}),held);
      await survivor.evaluate(async origin=>{const channel=new MessageChannel();globalThis.cancelled=await backend.request('open',{context:{url:origin+'/host-worker/prepare-held.js'}},[channel.port1]);globalThis.cancelPreparing=backend.request('prepare',{worker:cancelled.id,options:{options:{type:'module',credentials:'omit'}}}).then(()=> 'resolved',error=>error.name);},origin);
      await wait_for(()=>fixture.heldPreparations.size===1);
      assert.equal(await survivor.evaluate(async()=>{await backend.request('close',{worker:cancelled.id});return cancelPreparing;}),'AbortError');
      await wait_for(()=>fixture.heldPreparations.size===0);
      const count=fixture.preparationRequests.length;
      const deniedAuthority=await survivor.evaluate(async({origin,wanted})=>{
        const channel=new MessageChannel(),host=await backend.request('open',{context:{url:origin+'/host-worker/prepare-module.js',cookie_authority:wanted}},[channel.port1]);
        let sequence=0;const calls=new Map();channel.port2.onmessage=event=>{const resolve=calls.get(event.data.id);calls.delete(event.data.id);resolve(event.data.content);};
        const request=(procedure,args)=>new Promise(resolve=>{const id=++sequence;calls.set(id,resolve);channel.port2.postMessage({type:'procedure',id,procedure,arguments:args});});
        try{
          let preparation;try{await backend.request('prepare',{worker:host.id,options:{options:{type:'module',credentials:'include'}}});preparation='resolved';}catch(error){preparation=error.name;}
          const ordinary=await request('fetch',[host.id,'authority-check',origin+'/host-worker/prepare-echo',{mode:'cors',credentials:'include'}]);
          const forbidden=await request('prepare',[host.id]);
          const socket=await request('ws_new',[host.id,origin.replace(/^http/,'ws')+'/host-worker/socket',['retained']]);
          const events=await request('ws_event',[host.id,socket.value]);
          return {preparation,ordinary:ordinary.value.name,forbidden:forbidden.value.name,socket:events.value.map(event=>event[0])};
        }finally{channel.port2.close();await backend.request('close',{worker:host.id});}
      },{origin,wanted:denied?oldAuthority:'unavailable-authority'});
      assert.equal(deniedAuthority.preparation,'InvalidStateError');assert.equal(deniedAuthority.ordinary,'InvalidStateError');assert.equal(deniedAuthority.forbidden,'SecurityError');
      assert.ok(deniedAuthority.socket.includes('error'));assert.ok(!deniedAuthority.socket.includes('open'));assert.equal(fixture.preparationRequests.length,count);assert.deepEqual(direct,[]);
      passed.push('Retained '+(denied?'memory':'durable')+' script preparation follows redirects, cookies and referrer policy without direct source requests');
      passed.push('Retained '+(denied?'memory':'durable')+' classic sources execute opaque with captured Blob imports, worker fetch and relayed WebSockets');
      passed.push('Retained '+(denied?'memory':'durable')+' source loads survive creator UI loss and abort when their service closes');
      passed.push('Retained '+(denied?'memory':'durable')+' script, fetch and socket requests cannot borrow another cookie authority');
    }finally{clearTimeout(deadline);fixture.releasePreparations();await context.close();}
  }
  return passed;
}
