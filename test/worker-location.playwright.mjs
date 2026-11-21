import assert from 'node:assert/strict';

export async function verifyWorkerLocation(page){
  const context=await page.context().browser().newContext(),native=await context.newPage(),fixture=await page.context().newPage();
  const origin='https://worker-location.test',html='<!doctype html><body>Worker Location',errors=[],direct=[];
  const source=`onmessage=event=>{
    const entry=event.data,parsed=new URL(entry);
    const normalize=value=>value===entry?'[worker URL]':value===entry+'#patched'?'[patched worker URL]':parsed.protocol==='blob:'&&value===parsed.pathname?'[worker path]':value;
    const capture=operation=>{try{return {value:normalize(operation()??null)};}catch(error){return {error:error.name};}};
    const prototype=WorkerLocation.prototype;
    const result={entryMatches:location.href===entry,instance:location instanceof WorkerLocation,prototype:Object.getPrototypeOf(location)===prototype,constructor:location.constructor===WorkerLocation,tag:Object.prototype.toString.call(location),own:Reflect.ownKeys(location).map(String)};
    result.properties=[];
    for(const key of ['href','origin','protocol','host','hostname','port','pathname','search','hash']){
      const descriptor=Object.getOwnPropertyDescriptor(prototype,key);
      result.properties.push({key,value:normalize(location[key]),own:Object.hasOwn(location,key),getter:{name:descriptor.get.name,length:descriptor.get.length,enumerable:descriptor.enumerable,configurable:descriptor.configurable},borrow:capture(()=>descriptor.get.call(location)),invalid:capture(()=>descriptor.get.call({})),write:capture(()=>{(function(){'use strict';location[key]='changed';})();})});
    }
    result.methods={string:normalize(String(location)),name:location.toString.name,length:location.toString.length,inherited:location.toString===prototype.toString,borrow:capture(()=>prototype.toString.call(location)),invalid:capture(()=>prototype.toString.call({})),construct:capture(()=>new WorkerLocation()),clone:capture(()=>structuredClone(location))};
    const href=Object.getOwnPropertyDescriptor(prototype,'href');
    try{Object.defineProperty(prototype,'href',{...href,get(){return href.get.call(this)+'#patched';}});result.patched=normalize(location.href);}finally{Object.defineProperty(prototype,'href',href);}
    postMessage({workerLocation:result});
  }`;
  const run=async({type,blob,source})=>{
    const url=blob?URL.createObjectURL(new Blob([source],{type:'text/javascript'})):'https://worker-location.test/worker.js?query=value#fragment';
    const worker=new Worker(url,{type});
    try{return JSON.stringify(await new Promise((resolve,reject)=>{worker.onmessage=event=>resolve(event.data.workerLocation);worker.onerror=event=>reject(new Error(event.message));worker.postMessage(url);}));}
    finally{worker.terminate();if(blob)URL.revokeObjectURL(url);}
  };
  try{
    for(const surface of [native,fixture])surface.on('pageerror',error=>errors.push(error.message));
    await native.route(origin+'/**',route=>route.fulfill({contentType:route.request().url().includes('/worker.js')?'text/javascript':'text/html',body:route.request().url().includes('/worker.js')?source:html}));
    await native.goto(origin+'/parent');
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.evaluate(({origin,html,source})=>{main_frame.on_load=()=>{};sandstone.network.session.fetch=async url=>new Response(String(url).includes('/worker.js')?source:html,{headers:{'content-type':String(url).includes('/worker.js')?'text/javascript':'text/html','cache-control':'no-store'}});return main_frame.navigate_to(origin+'/parent');},{origin,html,source});
    for(const type of ['classic','module'])for(const blob of [false,true]){
      const args={type,blob,source};
      const expected=JSON.parse(await native.evaluate(({source,args})=>eval('('+source+')')(args),{source:run.toString(),args}));
      const actual=JSON.parse(await fixture.evaluate(source=>main_frame.eval_js(source),'('+run.toString()+')('+JSON.stringify(args)+')'));
      assert.deepEqual(actual,expected,type+(blob?' Blob':' HTTP')+' WorkerLocation differs from native behavior');
      assert.equal(actual.entryMatches,true);
    }
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
  }finally{await fixture.close();await context.close();}
  return ['HTTP and Blob classic/module workers expose native WorkerLocation prototypes, readonly getters and receiver checks','WorkerLocation borrowing, instrumentation and structured clone restrictions match native behavior'];
}
