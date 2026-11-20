import {createServer} from 'node:http';
import {once} from 'node:events';

export async function verifyWorkerBundles(page){
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
    '/worker-bundles/late.js':'self.chunkValue=42;self.chunkCount=(self.chunkCount||0)+1;'
  };
  // A real redirect is essential: Chromium labels imported classic scripts
  // with the requested URL, so stack-derived bundle paths use that directory.
  const nativeRequests=[];
  const server=createServer((request,response)=>{
    const path=new URL(request.url,'http://localhost').pathname;
    nativeRequests.push(path);
    if(path.endsWith('/runtime-redirect.js')){
      response.writeHead(302,{location:'/worker-bundles/assets/runtime.js'});response.end();return;
    }
    response.writeHead(path.endsWith('/missing.js')?404:200,{'Content-Type':path.endsWith('/index')?'text/html':'application/javascript'});
    response.end(path.endsWith('/main.js')?main('./runtime-redirect.js'):sources[path]||'');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port,start=origin+'/worker-bundles/index';
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage();
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
    if(expected[0].value!==42||expected[1].count!==2||expected[2].error!=='NetworkError')throw new Error('Native lazy bundle failed: '+JSON.stringify(expected));
    if(!nativeRequests.includes('/worker-bundles/runtime-redirect.js')||!nativeRequests.includes('/worker-bundles/assets/runtime.js'))throw new Error('Native worker redirect was not exercised');
    await page.evaluate(async({origin,start,entry,sources})=>{
      const previous=sandstone.network.session.fetch;globalThis.workerBundleRequests=[];
      sandstone.network.session.fetch=async(url,options)=>{
        const path=new URL(url).pathname;if(!path.startsWith('/worker-bundles/'))return previous(url,options);
        workerBundleRequests.push(path);
        if(path.endsWith('/runtime-redirect.js'))return new Response(null,{status:302,headers:{location:origin+'/worker-bundles/assets/runtime.js'}});
        return new Response(path.endsWith('/main.js')?entry:path.endsWith('/index')?'<!doctype html><body>Worker bundles':sources[path]||'',{
          status:path.endsWith('/missing.js')?404:200,headers:{'Content-Type':path.endsWith('/index')?'text/html':'application/javascript'}
        });
      };
      await main_frame.navigate_to(start);
    },{origin,start,entry:main('./runtime-redirect.js'),sources});
    const actual=await run(true);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Lazy worker bundle parity: '+JSON.stringify({expected,actual}));
    const requests=await page.evaluate(()=>workerBundleRequests);
    for(const path of ['/worker-bundles/main.js','/worker-bundles/effect','/worker-bundles/late.js','/worker-bundles/missing.js']){
      if(requests.filter(value=>value===path).length!==1)throw new Error('Worker bundle requests repeated or missing: '+JSON.stringify(requests));
    }
    return ['Lazy worker bundle manifests preload synchronous imports used after messages', 'Imported runtime redirects retain the requested stack filename for asset lookup', 'Worker preloading preserves repeated import execution and deferred failures'];
  }finally{await nativeContext.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
