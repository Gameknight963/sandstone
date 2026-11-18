async page=>{
  const origin='https://cache-storage.test',other='https://cache-other.test',context=await page.context().browser().newContext(),native=await context.newPage(),direct=[];
  const html='<!doctype html><title>Cache fixture</title><body>Cache fixture';
  const worker=`onmessage=async()=>{try{const cache=await caches.open('worker-cache');postMessage({body:await(await cache.match('/worker-value')).text(),names:await caches.keys()});}catch(error){postMessage({error:error.name+': '+error.message});}};`;
  const childCode=`(async()=>{const result={probe:'cache-opaque'};try{const value=caches;result.access=typeof value;try{await value.keys();result.operation='ok';}catch(error){result.operation=error.name;}}catch(error){result.access=error.name;}parent.postMessage(result,'*');})();`;
  const opaqueHTML='<script>'+childCode+'</script>';
  const fixture=url=>{const target=new URL(url);return {body:target.pathname==='/worker.js'?worker:target.pathname.startsWith('/net-')?'served:'+target.pathname:target.pathname==='/opaque-cache'?opaqueHTML:html,type:target.pathname==='/worker.js'?'text/javascript':target.pathname.startsWith('/net-')?'text/plain':'text/html',status:target.pathname==='/net-fail'?500:200};};
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const scenario=async()=>{
    for(const name of await caches.keys())await caches.delete(name);
    const results=[],error=async action=>{try{await action();return 'ok';}catch(value){return value.name;}};
    const requestView=request=>({url:request.url,method:request.method,headers:[...request.headers],mode:request.mode,credentials:request.credentials,referrer:request.referrer,cache:request.cache,redirect:request.redirect,referrerPolicy:request.referrerPolicy,integrity:request.integrity});
    const cache=await caches.open('assets'),again=await caches.open('assets');await caches.open('second');
    results.push({names:await caches.keys(),typed:cache instanceof Cache,manager:caches instanceof CacheStorage,tag:Object.prototype.toString.call(cache)});
    const en=new Request('/asset?q=one#fragment',{headers:{'accept-language':'en'},referrer:location.origin+'/source'}),fr=new Request('/asset?q=one',{headers:{'accept-language':'fr'}});
    const response=new Response(new Uint8Array([1,2,255]),{status:404,statusText:'Authored',headers:{vary:'accept-language','x-sandstone-cache-record':'authored'}});
    const writing=cache.put(en,response),usedImmediately=response.bodyUsed;await writing;
    const found=await again.match(new Request('/asset?q=two',{headers:{'accept-language':'en'}}),{ignoreSearch:true});
    if(!found)throw new Error('Missing Vary representation: '+JSON.stringify({keys:(await cache.keys()).map(requestView),responses:(await cache.matchAll()).map(response=>[...response.headers])}));
    results.push({usedImmediately,status:found.status,statusText:found.statusText,type:found.type,url:found.url,headers:[...found.headers],body:[...new Uint8Array(await found.clone().arrayBuffer())],again:[...new Uint8Array(await found.arrayBuffer())],miss:await cache.match('/asset?q=one')===undefined});
    await cache.put(fr,new Response('French',{headers:{vary:'accept-language'}}));
    await cache.put(new Request('/key-metadata',{headers:{'x-custom':'value'},mode:'same-origin',credentials:'include',cache:'no-store',redirect:'manual',referrer:location.origin+'/source',referrerPolicy:'no-referrer',integrity:'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',keepalive:true}),new Response('key'));
    const key=(await cache.keys('/key-metadata'))[0];key.headers.set('x-added','yes');
    results.push({key:requestView(key),clone:requestView(key.clone()),headerAdded:key.headers.get('x-added')});await cache.delete('/key-metadata');
    results.push({keys:(await cache.keys()).map(requestView),variants:await Promise.all((await cache.matchAll('/asset?q=one',{ignoreVary:true})).map(response=>response.text())),postMiss:await cache.match(new Request('/asset?q=one',{method:'POST'}))===undefined,postHit:!!await cache.match(new Request('/asset?q=one',{method:'POST'}),{ignoreMethod:true,ignoreVary:true})});
    results.push({deleted:await cache.delete(fr),remaining:(await cache.keys()).map(request=>request.headers.get('accept-language'))});
    await cache.put('/bodyless',new Response(null));await cache.put('/no-content',new Response(null,{status:204}));
    results.push({bodyless:(await cache.match('/bodyless')).body===null,noContent:(await cache.match('/no-content')).body===null});
    const locked=new Response('locked'),reader=locked.body.getReader(),consumed=new Response('consumed');await consumed.text();
    results.push({missing:await error(()=>cache.match()),badMethod:await error(()=>cache.put(new Request('/post',{method:'POST'}),new Response('post'))),partial:await error(()=>cache.put('/partial',new Response('partial',{status:206}))),vary:await error(()=>cache.put('/vary',new Response('vary',{headers:{vary:'*'}}))),errorResponse:await error(()=>cache.put('/error',Response.error())),locked:await error(()=>cache.put('/locked',locked)),consumed:await error(()=>cache.put('/used',consumed)),receiver:await error(()=>Cache.prototype.match.call({},'/x')),symbol:await error(()=>caches.open(Symbol('name')))});reader.releaseLock();
    await cache.addAll(['/net-one','/net-two']);
    results.push({added:await(await cache.match('/net-one')).text(),url:(await cache.match('/net-two')).url,failed:await error(()=>cache.addAll(['/net-new','/net-fail'])),atomic:await cache.match('/net-new')===undefined,duplicate:await error(()=>cache.addAll(['/net-duplicate#a','/net-duplicate#b'])),duplicateStored:!!await cache.match('/net-duplicate')});
    const fetched=await fetch('/net-metadata'),metadata={type:fetched.type,url:fetched.url,redirected:fetched.redirected,headers:[...fetched.headers]};await cache.put('/fetched',fetched);const cached=await cache.match('/fetched');
    results.push({fetchType:cached.type===metadata.type,fetchURL:cached.url===metadata.url,fetchRedirect:cached.redirected===metadata.redirected,fetchHeaders:JSON.stringify([...cached.headers])===JSON.stringify(metadata.headers),cloneURL:cached.clone().url===metadata.url});
    results.push({searchAll:await(await caches.match('/net-one')).text(),namedMiss:await caches.match('/net-one',{cacheName:'second'})===undefined,missing:await caches.has('missing')});
    await caches.delete('assets');const fresh=await caches.open('assets');
    results.push({retained:await(await cache.match('/net-one')).text(),fresh:await fresh.match('/net-one')===undefined,order:await caches.keys()});
    const shared=await caches.open('worker-cache');await shared.put('/worker-value',new Response('shared'));
    localStorage.setItem('cache-sentinel','keep');return JSON.stringify(results);
  };
  const install=()=>page.evaluate(({origin,other,html,worker,opaqueHTML})=>{
    const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(url,options)=>{
      const target=new URL(url);if(![origin,other].includes(target.origin))return previous(url,options);
      const script=target.pathname==='/worker.js',network=target.pathname.startsWith('/net-');
      return Promise.resolve(new Response(script?worker:network?'served:'+target.pathname:target.pathname==='/opaque-cache'?opaqueHTML:html,{status:target.pathname==='/net-fail'?500:200,statusText:target.pathname==='/net-fail'?'Internal Server Error':'OK',headers:{'Content-Type':script?'text/javascript':network?'text/plain':'text/html'}}));
    };
  },{origin,other,html,worker,opaqueHTML});
  const block=route=>{direct.push(route.request().url());return route.abort();};
  try{
    await native.route(origin+'/**',route=>{const value=fixture(route.request().url());return route.fulfill({status:value.status,contentType:value.type,body:value.body});});
    await page.route(/^https?:/,block);await install();
    await native.goto(origin+'/base/page');await page.evaluate(url=>main_frame.navigate_to(url),origin+'/base/page');
    const expected=await native.evaluate(scenario),actual=await evaluate(true,'('+scenario.toString()+')()');
    if(actual!==expected)throw new Error('Cache API native parity differs: '+JSON.stringify({expected:JSON.parse(expected),actual:JSON.parse(actual)}));
    const work=`(async()=>{const worker=new Worker('/worker.js');try{return JSON.stringify(await new Promise((resolve,reject)=>{worker.onmessage=event=>resolve(event.data);worker.onerror=reject;worker.postMessage('read');}));}finally{worker.terminate();}})()`;
    const nativeWorker=await evaluate(false,work),proxyWorker=await evaluate(true,work);if(proxyWorker!==nativeWorker)throw new Error('Worker CacheStorage differs: '+proxyWorker+' expected '+nativeWorker);
    const opaque=`(async()=>{const iframe=document.createElement('iframe');iframe.sandbox='allow-scripts';const result=new Promise((resolve,reject)=>{const listener=event=>{if(event.data?.probe==='cache-opaque'){removeEventListener('message',listener);resolve(event.data);}};addEventListener('message',listener);setTimeout(()=>{removeEventListener('message',listener);reject(new Error('Opaque cache probe timed out'));},3000);});iframe.src=${JSON.stringify(origin+'/opaque-cache')};document.body.append(iframe);try{return JSON.stringify(await result);}finally{iframe.remove();}})()`;
    const nativeOpaque=await evaluate(false,opaque),proxyOpaque=await evaluate(true,opaque);if(proxyOpaque!==nativeOpaque)throw new Error('Opaque CacheStorage differs: '+proxyOpaque+' expected '+nativeOpaque);
    await page.evaluate(url=>main_frame.navigate_to(url),other+'/page');
    const isolated=await evaluate(true,'(async()=>JSON.stringify({names:await caches.keys(),match:!!await caches.match("/worker-value")}))()');
    if(isolated!=='{"names":[],"match":false}')throw new Error('CacheStorage leaked across origins: '+isolated);
    await page.evaluate(async()=>{await sandstone.controller.cache_storage.catalog();document.getElementById('options_button').click();document.getElementById('site_data_details').open=true;});
    const row=page.locator('.site_data_row').filter({hasText:'cache-storage.test:'});await row.getByRole('button',{name:'Clear caches',exact:true}).click();
    await page.evaluate(url=>main_frame.navigate_to(url),origin+'/after-clear');
    const cleared=await evaluate(true,'(async()=>JSON.stringify({names:await caches.keys(),local:localStorage.getItem("cache-sentinel")}))()');
    if(cleared!=='{"names":[],"local":"keep"}')throw new Error('Per-site cache clearing changed unrelated storage: '+cleared);
    await evaluate(true,'(async()=>{const cache=await caches.open("persistence");await cache.put("/persisted",new Response("saved cache"));})()');
    await page.evaluate(()=>{if(document.getElementById('options_div').style.display!=='none')document.getElementById('close_options_button').click();});
    if(direct.length)throw new Error('Cache API attempted direct HTTP: '+JSON.stringify(direct));
    return ['CacheStorage/Cache preserve native queries, Vary, response bodies and request metadata','Cache add/addAll fetch through the relay and reject failed/duplicate batches atomically','Deleted cache objects retain their entries while reopened names start empty','Window and worker caches share committed data within their virtual origin','Cache origins stay isolated and per-site clearing preserves unrelated storage'];
  }finally{await context.close();await page.unroute(/^https?:/,block);}
}
