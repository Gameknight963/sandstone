async page=>{
  const origin='https://classic-private.test';
  const exercise=`(async()=>{
    const local=(function(__ctx__,__get_this__,__get_var__){
      return [__ctx__,__get_this__,__get_var__,location.pathname,this===globalThis,(function(){'use strict';return this})()===undefined];
    })('local',null,12);
    const scoped=(function(){with({__ctx__:null,__get_this__:null})return [location.pathname,this===globalThis]})();
    const hostile=(function(){with(new Proxy({},{has:()=>true,get:(target,key)=>key===Symbol.unscopables?undefined:String(key)}))return [location,__ctx__]})();
    const module=await import('./module.js');
    return {local,scoped,hostile,module:module.value,text:await (await fetch('/data')).text(),globals:[__ctx__,__get_this__,__get_var__],visible:['__ctx__','__get_this__','__get_var__'].map(key=>[key,Object.hasOwn(globalThis,key),Object.getOwnPropertyDescriptor(globalThis,key)?.configurable])};
  })()`;
  const declarations=kind=>`${kind} __ctx__='authored',__get_this__=null,__get_var__=9;`;
  const sources={
    '/module.js':`export const value=[location.pathname,(function(){return this})()===undefined];`,
    '/data':'relayed',
    '/worker-var.js':declarations('var')+`importScripts('/worker-part.js');`,
    '/worker-let.js':declarations('let')+`importScripts('/worker-part.js');`,
    '/worker-part.js':`onmessage=async()=>{try{postMessage({result:await ${exercise}})}catch(error){postMessage({error:error.stack})}};`
  };
  const documents=Object.fromEntries(['var','let'].map(kind=>['/'+kind,'<!doctype html><body><iframe src="/child"></iframe>'+`<script>${declarations(kind)}globalThis.result=${exercise};<\/script>`]));
  documents['/child']='<!doctype html><body><script>'+declarations('var')+`history.replaceState(null,'','/child-ready');globalThis.childValue='ready';<\/script>`;
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route(origin+'/**',route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({contentType:path.endsWith('.js')?'text/javascript':path==='/data'?'text/plain':'text/html',body:sources[path]||documents[path]||''});});
  await page.evaluate(({origin,sources,documents})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(url,options)=>{
    if(new URL(url).origin!==origin)return previous(url,options);
    const path=new URL(url).pathname;return Promise.resolve(new Response(sources[path]||documents[path]||'',{headers:{'Content-Type':path.endsWith('.js')?'text/javascript':path==='/data'?'text/plain':'text/html'}}));
  };},{origin,sources,documents});
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const run=async proxy=>{
    const results=[];
    for(const kind of ['var','let']){
      if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),origin+'/'+kind);else await native.goto(origin+'/'+kind);
      const result=await evaluate(proxy,'globalThis.result');
      if(!result||result.text!=='relayed')throw new Error('Classic script did not finish: '+kind);
      results.push(result);
      results.push(await evaluate(proxy,`new Promise((resolve,reject)=>{const deadline=Date.now()+5000;const check=()=>{const frame=document.querySelector('iframe');if(frame.contentWindow.childValue==='ready')resolve([frame.contentWindow.location.pathname,frame.contentDocument.URL,frame.contentWindow.__ctx__]);else if(Date.now()>deadline)reject(new Error('Child runtime context timed out'));else setTimeout(check,20)};check()})`));
      const worker=await evaluate(proxy,`new Promise((resolve,reject)=>{const worker=new Worker('/worker-${kind}.js');worker.onmessage=event=>{worker.terminate();resolve(event.data)};worker.onerror=event=>{worker.terminate();reject(new Error(event.message))};worker.postMessage(true)})`);
      if(!worker.result||worker.result.text!=='relayed')throw new Error('Classic worker did not finish: '+JSON.stringify(worker));
      results.push(worker);
    }
    return results;
  };
  try{const expected=await run(false),actual=await run(true);if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Classic helper collisions differ: '+JSON.stringify({actual,expected}));return ['Classic scripts preserve authored helper variables, global declarations and with scopes','Classic importScripts and later module imports remain usable after helper-name declarations','Same-origin frame access remains usable when parent and child declare helper names'];}
  finally{await context.close()}
}
