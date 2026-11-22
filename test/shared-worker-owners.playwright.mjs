import assert from 'node:assert/strict';
import {wait_for} from './wait-for.mjs';

export async function verify_shared_worker_owners(browser,origin){
  const context=await browser.newContext(),deadline=setTimeout(()=>context.close().catch(()=>{}),45000);
  const load=async()=>{
    const page=await context.newPage();await page.goto(origin+'/host-worker/page');await page.addScriptTag({url:origin+'/host-worker/bundle.js'});
    await page.evaluate(async websocket=>{
      globalThis.backend=await sandstone.worker_backends.get({websocket});
      globalThis.delegate=await sandstone.worker_backends.register_owners(backend);
      globalThis.actorClients=new Map();
      globalThis.acquireActor=async({document,descriptor,nativeURL})=>{
        const result=await backend.request('actor-acquire',{document,descriptor,initialization:{native_url:nativeURL}});
        const port=result.ports[0];port.start();actorClients.set(document,{...result,port});
        return {id:result.id,url:result.profile.url,created:result.created};
      };
      globalThis.actorMessage=(document,value)=>new Promise(resolve=>{const port=actorClients.get(document).port;port.onmessage=event=>resolve(event.data);port.postMessage(value);});
    },origin.replace(/^http/,'ws')+'/');return page;
  };
  const acquire=(page,document,descriptor,nativeURL)=>page.evaluate(input=>acquireActor(input),{document,descriptor,nativeURL});
  const send=(page,document,value)=>page.evaluate(({document,value})=>actorMessage(document,value),{document,value});
  try{
    const a=await load(),b=await load();
    const source='/* '+crypto.randomUUID()+' */let count=0;onconnect=event=>{const port=event.ports[0];port.onmessage=event=>port.postMessage({count:++count,value:event.data,origin});port.start();};';
    const nativeURL='data:text/javascript,'+encodeURIComponent(source),descriptor={storage_key:'https://actor-owner.test',url:'https://actor-owner.test/shared.js',secure_context:true,options:{name:'shared'}};
    const [first,second]=await Promise.all([acquire(a,'document',descriptor,nativeURL),acquire(b,'document',descriptor,nativeURL)]);
    assert.equal(first.id,second.id);assert.equal(first.url,second.url);assert.deepEqual([first.created,second.created].sort(),[false,true]);
    const initial=await Promise.all([send(a,'document','a'),send(b,'document','b')]);
    assert.deepEqual(initial.map(value=>value.count).sort(),[1,2]);assert.ok(initial.every(value=>value.origin==='null'));
    const sibling=await acquire(a,'sibling',descriptor,nativeURL);assert.equal(sibling.id,first.id);assert.equal(await a.evaluate(()=>document.querySelectorAll('iframe').length),1);
    assert.equal((await send(a,'sibling','same UI')).count,3);
    await a.evaluate(()=>backend.request('actor-release',{document:'document'}));
    assert.equal((await send(a,'sibling','remaining document')).count,4);
    await a.close();assert.equal((await send(b,'document','remaining UI')).count,5);
    const mismatch=await b.evaluate(async({descriptor,nativeURL})=>{
      try{await acquireActor({document:'mismatch',descriptor:{...descriptor,options:{...descriptor.options,type:'module'}},nativeURL});return 'accepted';}
      catch(error){return error.name;}
    },{descriptor,nativeURL});assert.equal(mismatch,'SharedWorkerMismatchError');
    const partition={...descriptor,storage_key:'https://other-top.test|https://actor-owner.test'};
    const isolated=await acquire(b,'partition',partition,nativeURL);assert.notEqual(isolated.id,first.id);assert.notEqual(isolated.url,first.url);
    assert.equal((await send(b,'partition','isolated')).count,1);
    await b.evaluate(id=>backend.request('actor-close',{worker:id}),isolated.id);
    await wait_for(async()=>await b.evaluate(()=>document.querySelectorAll('iframe').length)===1);
    await b.evaluate(()=>backend.request('actor-release',{document:'document'}));
    const duringGrace=await acquire(b,'returning',descriptor,nativeURL);assert.equal(duringGrace.id,first.id);assert.equal((await send(b,'returning','within grace')).count,6);
    await b.evaluate(()=>backend.request('actor-release',{document:'returning'}));
    await wait_for(async()=>await b.evaluate(()=>document.querySelectorAll('iframe').length)===0,{timeout:10000});
    const fresh=await acquire(b,'fresh',descriptor,nativeURL);assert.notEqual(fresh.id,first.id);assert.equal((await send(b,'fresh','after disposal')).count,1);
    const failure=await b.evaluate(async descriptor=>{
      const reported=new Promise(resolve=>backend.events.addEventListener('actor-error',event=>resolve(event.data),{once:true}));
      const failed=await acquireActor({document:'failed',descriptor:{...descriptor,url:'https://actor-owner.test/failed.js'},nativeURL:'data:text/javascript,'+encodeURIComponent('throw new Error("actor startup failed")')});
      const error=await reported;actorClients.get('failed').port.close();await backend.request('actor-close',{worker:failed.id});
      return {worker:error.worker===failed.id,client:Number.isSafeInteger(error.client),message:!!error.message};
    },descriptor);assert.deepEqual(failure,{worker:true,client:true,message:true});
    const cancelled=await b.evaluate(async({descriptor,nativeURL})=>{
      const csp=document.createElement('meta');csp.httpEquiv='Content-Security-Policy';csp.content="script-src 'none'";document.head.append(csp);
      const pending=backend.request('actor-acquire',{document:'cancelled',descriptor:{...descriptor,url:'https://actor-owner.test/cancelled.js'},initialization:{native_url:nativeURL}}).then(value=>({value}),error=>({name:error.name}));
      await backend.request('actor-release',{document:'cancelled'});return pending;
    },{descriptor,nativeURL});assert.equal(cancelled.name,'AbortError');
    assert.equal((await send(b,'fresh','unrelated actor survives')).count,2);
    await b.evaluate(id=>backend.request('actor-close',{worker:id}),fresh.id);
    await wait_for(async()=>await b.evaluate(()=>document.querySelectorAll('iframe').length)===0);
    return ['Backend registry delegates one native owner per UI and reuses actors across logical documents','A physical UI closing retires only its own logical owners','Virtual storage partitions receive distinct native actors even for the same script and name','An actor is reused during idle grace and gets fresh state after registry disposal','Native constructor errors reach the requesting UI with actor and client identity','Cancelled owner creation settles without damaging another actor in the same UI'];
  }finally{clearTimeout(deadline);await context.close();}
}
