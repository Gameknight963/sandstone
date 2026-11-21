import assert from 'node:assert/strict';

export async function verifyWorkerInterface(page){
  const context=await page.context().browser().newContext(),native=await context.newPage(),fixture=await page.context().newPage();
  const origin='https://worker-interface.test',html='<!doctype html><body>Worker interface',source='postMessage({name:self.name});',errors=[],direct=[];
  const run=async()=>{
    const url='https://worker-interface.test/worker.js',results=[];
    const capture=operation=>{try{return {value:operation()??null};}catch(error){return {error:error.name};}};
    const construct=(...args)=>capture(()=>{const worker=new Worker(...args);worker.terminate();return 'created';});
    results.push(construct(),construct(Symbol('url')),construct(url,null),construct(url,0),construct(url,{type:''}),construct(url,{credentials:''}),construct('http://['));
    const order=[];
    results.push(construct({toString(){order.push('url');return url;}},{get credentials(){order.push('credentials');return 'same-origin';},get name(){order.push('name');return 'test';},get type(){order.push('type');return 'classic';},get unrelated(){throw new Error('Unrelated options must not be read');}}),{order});
    const worker=new Worker(url);worker.terminate();
    results.push(capture(()=>worker.postMessage()),capture(()=>worker.postMessage(()=>{})));
    for(const dictionary of [false,true]){
      const buffer=new ArrayBuffer(4);
      results.push({dictionary,outcome:capture(()=>worker.postMessage(buffer,dictionary?{transfer:[buffer]}:[buffer])),bytes:buffer.byteLength});
    }
    const duplicate=new ArrayBuffer(4);results.push({duplicate:capture(()=>worker.postMessage(null,[duplicate,duplicate])),bytes:duplicate.byteLength});
    for(const type of ['message','messageerror','error']){
      const seen=[],handler='on'+type,descriptor=Object.getOwnPropertyDescriptor(Worker.prototype,handler);
      results.push({type,own:Object.hasOwn(worker,handler),placement:!!descriptor,invalid:descriptor?capture(()=>descriptor.get.call({})):null});
      worker.addEventListener(type,()=>seen.push('first'));
      worker[handler]=()=>seen.push('old');worker.addEventListener(type,()=>seen.push('last'));
      const replacement=function(event){seen.push(this===worker&&event.target===worker?'new':'bad receiver');return false;};
      replacement.call=()=>{throw new Error('An event handler must not invoke an authored call property');};
      worker[handler]=replacement;
      const event=new Event(type,{cancelable:true});
      results.push({type,identity:worker[handler]===replacement,dispatch:worker.dispatchEvent(event),prevented:event.defaultPrevented,seen:[...seen]});
      worker[handler]=null;worker[handler]=()=>seen.push('reinstalled');seen.length=0;
      worker.dispatchEvent(new Event(type));results.push({type,reinstalled:seen});
    }
    for(const type of ['classic','module']){
      const named=new Worker(url,Object.create({name:123,type,credentials:'same-origin'}));
      try{results.push({type,named:await new Promise((resolve,reject)=>{named.onmessage=event=>resolve(event.data);named.onerror=event=>{event.preventDefault();reject(new Error(event.message));};})});}
      finally{named.terminate();}
    }
    const frame=document.createElement('iframe');frame.src='https://worker-interface.test/peer';
    try{
      await new Promise(resolve=>{frame.onload=resolve;document.body.append(frame);});
      const foreign=new frame.contentWindow.Worker(url);
      results.push({foreign:capture(()=>{
        const descriptor=Object.getOwnPropertyDescriptor(Worker.prototype,'onmessage'),seen=[];
        const callback=function(){seen.push(this===foreign);};
        descriptor.set.call(foreign,callback);foreign.dispatchEvent(new Event('message'));
        Worker.prototype.terminate.call(foreign);
        const buffer=new ArrayBuffer(4);Worker.prototype.postMessage.call(foreign,buffer,[buffer]);
        return {borrowed:descriptor.get.call(foreign)===callback,local:foreign.onmessage===callback,seen,bytes:buffer.byteLength};
      })});
    }finally{frame.remove();}
    return JSON.stringify(results);
  };
  try{
    for(const surface of [native,fixture])surface.on('pageerror',error=>errors.push(error.message));
    await native.route(origin+'/**',route=>route.fulfill({contentType:route.request().url().endsWith('/worker.js')?'text/javascript':'text/html',body:route.request().url().endsWith('/worker.js')?source:html}));
    await native.goto(origin+'/parent');const expected=JSON.parse(await native.evaluate(source=>eval('('+source+')')(),run.toString()));
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.evaluate(({origin,html,source})=>{main_frame.on_load=()=>{};sandstone.network.session.fetch=async url=>new Response(String(url).endsWith('/worker.js')?source:html,{headers:{'content-type':String(url).endsWith('/worker.js')?'text/javascript':'text/html','cache-control':'no-store'}});return main_frame.navigate_to(origin+'/parent');},{origin,html,source});
    const actual=JSON.parse(await fixture.evaluate(source=>main_frame.eval_js('('+source+')()'),run.toString()));
    assert.deepEqual(actual,expected);assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
  }finally{await fixture.close();await context.close();}
  return ['Worker constructor dictionaries preserve native conversion order, inherited options and validation','Worker message transfers, borrowed methods and event handler ordering match native behavior'];
}
