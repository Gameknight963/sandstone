async page=>{
  const origin='https://fixture.test',start=origin+'/worker-bundles/index';
  const main=runtime=>`importScripts(${JSON.stringify(runtime)});
    fetch('/worker-bundles/effect').catch(()=>{});
    onmessage=event=>{
      const order=['before'];let error;
      try{importScripts(registry.resolve(event.data));order.push('after');}catch(value){error=value.name;}
      postMessage({order,error,value:self.chunkValue,count:self.chunkCount});
    };`;
  const runtime=String.raw`
    const registry={assets:new Map(),register(base,pairs){for(let i=0;i<pairs.length;i+=2)this.assets.set(pairs[i],new URL(pairs[i+1],base).href);},resolve(id){return this.assets.get(id);}};
    const bundle={getBundleURL(){const file=new Error().stack.match(/https?:\/\/[^)\s]+/)[0];return file.replace(/\/[^/]+$/,'/');}};
    registry.register(bundle.getBundleURL('worker'),JSON.parse('["main","../main.js","late","./late.js","missing","./missing.js"]'));
  `;
  const sources={
    '/worker-bundles/assets/runtime.js':runtime,
    '/worker-bundles/assets/late.js':'self.chunkValue=42;self.chunkCount=(self.chunkCount||0)+1;'
  };
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage();
  // Routing cannot intercept a redirect follow-up, so use the final runtime URL
  // in the native entry. The proxied entry below exercises the actual 302 path.
  await nativeContext.route(origin+'/worker-bundles/**',route=>{
    const path=new URL(route.request().url()).pathname;
    return route.fulfill({status:path.endsWith('/missing.js')?404:200,contentType:'application/javascript',body:
      path.endsWith('/main.js')?main('./assets/runtime.js'):sources[path]||''});
  });
  const run=async proxy=>JSON.parse(await(proxy?page.evaluate(source=>main_frame.eval_js(source),`new Promise((resolve,reject)=>{
    const values=[],worker=new Worker('${origin}/worker-bundles/main.js');
    worker.onerror=event=>{event.preventDefault();worker.terminate();reject(new Error(event.message));};
    worker.onmessage=event=>{values.push(event.data);if(values.length===3){worker.terminate();resolve(JSON.stringify(values));}else worker.postMessage(values.length===1?'late':'missing');};
    worker.postMessage('late');
  })`):native.evaluate(async origin=>{
    return new Promise((resolve,reject)=>{
      const values=[],worker=new Worker(origin+'/worker-bundles/main.js');
      worker.onerror=event=>{event.preventDefault();worker.terminate();reject(new Error(event.message));};
      worker.onmessage=event=>{values.push(event.data);if(values.length===3){worker.terminate();resolve(JSON.stringify(values));}else worker.postMessage(values.length===1?'late':'missing');};
      worker.postMessage('late');
    });
  },origin)));
  try{
    await native.goto(start);const expected=await run(false);
    await page.evaluate(async({start,entry,sources})=>{
      const previous=sandstone.network.session.fetch;globalThis.workerBundleRequests=[];
      sandstone.network.session.fetch=async(url,options)=>{
        const path=new URL(url).pathname;if(!path.startsWith('/worker-bundles/'))return previous(url,options);
        workerBundleRequests.push(path);
        if(path.endsWith('/runtime-redirect.js'))return new Response(null,{status:302,headers:{location:'https://fixture.test/worker-bundles/assets/runtime.js'}});
        return new Response(path.endsWith('/main.js')?entry:path.endsWith('/index')?'<!doctype html><body>Worker bundles':sources[path]||'',{
          status:path.endsWith('/missing.js')?404:200,headers:{'Content-Type':path.endsWith('/index')?'text/html':'application/javascript'}
        });
      };
      await main_frame.navigate_to(start);
    },{start,entry:main('./runtime-redirect.js'),sources});
    const actual=await run(true);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Lazy worker bundle parity: '+JSON.stringify({expected,actual}));
    const requests=await page.evaluate(()=>workerBundleRequests);
    for(const path of ['/worker-bundles/main.js','/worker-bundles/effect','/worker-bundles/assets/late.js','/worker-bundles/assets/missing.js']){
      if(requests.filter(value=>value===path).length!==1)throw new Error('Worker bundle requests repeated or missing: '+JSON.stringify(requests));
    }
    return ['Lazy worker bundle manifests preload synchronous imports used after messages', 'Imported runtime redirects retain their asset base and script filename', 'Worker preloading preserves repeated import execution and deferred failures'];
  }finally{await nativeContext.close();}
}
