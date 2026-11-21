import assert from 'node:assert/strict';
import {wait_for} from './wait-for.mjs';

export async function verify_worker_discovery(browser,origin){
  const context=await browser.newContext(),errors=[];
  const deadline=setTimeout(()=>context.close().catch(()=>{}),45000);
  const load=async({denied=false}={})=>{
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/host-worker/page');
    await page.evaluate(()=>{
      globalThis.backendConstructors=0;
      globalThis.SharedWorker=class extends SharedWorker{constructor(...args){super(...args);backendConstructors++;}};
    });
    if(denied)await page.evaluate(()=>{for(const name of ['localStorage','sessionStorage'])Object.defineProperty(globalThis,name,{get(){throw new DOMException('Storage denied','SecurityError');}});});
    await page.addScriptTag({url:origin+'/host-worker/bundle.js'});return page;
  };
  const get=(page,websocket)=>page.evaluate(async websocket=>{
    globalThis.backend=await sandstone.worker_backends.get({websocket});
    const again=await sandstone.worker_backends.get({websocket});
    return {identity:backend.identity,url:backend.url,name:backend.name,cached:again===backend,constructors:backendConstructors};
  },websocket);
  try{
    const first=await load(),second=await load({denied:true}),observer=await load(),websocket=origin.replace(/^http/,'ws')+'/';
    const [a,b]=await Promise.all([get(first,websocket),get(second,websocket)]);
    assert.equal(a.identity,b.identity);assert.equal(a.url,b.url);assert.equal(a.name,b.name);
    assert.equal(a.cached,true);assert.equal(b.cached,true);assert.equal(a.constructors,1);assert.equal(b.constructors,1);
    await first.close();
    const third=await load(),c=await get(third,websocket);assert.equal(c.identity,a.identity);
    const alternate=await second.evaluate(async websocket=>{
      const otherRelay=await sandstone.worker_backends.get({websocket:websocket+'other-relay'});
      const hash=sandstone.version.hash;let otherBuild;
      try{sandstone.version.hash='different-build';otherBuild=await sandstone.worker_backends.get({websocket});}
      finally{sandstone.version.hash=hash;}
      const restored=await sandstone.worker_backends.get({websocket});
      return {relay:otherRelay.identity,build:otherBuild.identity,restored:restored===backend};
    },websocket);
    assert.notEqual(alternate.relay,a.identity);assert.notEqual(alternate.build,a.identity);assert.notEqual(alternate.relay,alternate.build);assert.equal(alternate.restored,true);
    await third.evaluate(()=>backend.request('shutdown').catch(error=>{if(error.name!=='AbortError')throw error;}));
    assert.deepEqual(await second.evaluate(async()=>({name:(await backend.closed).name,closed:backend.isClosed})),{name:'AbortError',closed:true});
    assert.equal(await third.evaluate(async()=>{await backend.closed;return backend.isClosed;}),true);
    const [replacement,rejoined]=await Promise.all([get(second,websocket),get(third,websocket)]);
    assert.notEqual(replacement.identity,a.identity);assert.equal(replacement.identity,rejoined.identity);
    await second.close();await third.close();
    await wait_for(async()=>observer.evaluate(async()=>{
      const state=await navigator.locks.query();return ![...state.held,...state.pending].some(lock=>lock.name.startsWith('sandstone.shared-backend.v1:')||lock.name.startsWith('sandstone.backend-owner.v1:'));
    }));
    const afterClosure=await get(observer,websocket);assert.notEqual(afterClosure.identity,replacement.identity);
    assert.deepEqual(errors,[]);
    return ['Concurrent UIs discover one embedded backend without persistent URL records','A new UI rediscovers the backend after its creating window closes','Backend discovery partitions relay configurations and host builds','Native backend death settles live connections and concurrent callers recreate one backend','Closing every UI releases backend discovery and owner leases'];
  }finally{clearTimeout(deadline);await context.close();}
}
