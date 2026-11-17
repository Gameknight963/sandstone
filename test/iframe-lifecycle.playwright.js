async page=>{
  const origin='https://lifecycle.test';
  const evaluate=source=>page.evaluate(source=>main_frame.eval_js(source),source);
  const until=async(predicate,label)=>{
    const expires=Date.now()+5000;
    while(!await predicate()){
      if(Date.now()>expires)throw new Error('Iframe lifecycle timed out: '+label+' '+JSON.stringify(await page.evaluate(()=>({requests:frameLifecycle.requests,signals:frameLifecycle.signals.map(entry=>({path:entry.path,aborted:entry.signal.aborted})),frames:Object.values(sandstone.controller.iframes).map(frame=>({url:frame.url.href,id:frame.id}))}))));
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  };
  await page.evaluate(async origin=>{
    const previous=sandstone.network.session.fetch;
    globalThis.frameLifecycle={signals:[],requests:[],unload:[]};
    sandstone.network.session.fetch=(url,options)=>{
      if(new URL(url).origin!==origin)return previous(url,options);
      const path=new URL(url).pathname;frameLifecycle.requests.push(path);
      if(path.startsWith('/unload-'))return new Promise(resolve=>frameLifecycle.unload.push({path,signal:options.signal,release(){resolve(new Response('done'));}}));
      if(path.startsWith('/held-')||path==='/slow')return new Promise((resolve,reject)=>{
        frameLifecycle.signals.push({path,signal:options.signal});
        options.signal.addEventListener('abort',()=>reject(new DOMException('Detached frame','AbortError')),{once:true});
      });
      let body='<!doctype html><body><div id="mount"></div><div id="other"></div>';
      if(path==='/child')body='<!doctype html><body><script>fetch("/held-child").catch(()=>{});new Worker("/worker.js");const frame=document.createElement("iframe");frame.src="/grandchild";document.body.append(frame);addEventListener("pagehide",()=>{navigator.sendBeacon("/unload-beacon","bye");fetch("/unload-keepalive",{method:"POST",body:"bye",keepalive:true}).catch(()=>{});});window.loaded=true;<\/script>';
      if(path==='/grandchild'||path==='/simple')body='<!doctype html><body><script>fetch("/held-'+path.slice(1)+'").catch(()=>{});window.loaded=true;<\/script>';
      if(path==='/worker.js')body='fetch("/held-worker").catch(()=>{});';
      return Promise.resolve(new Response(body,{headers:{'Content-Type':path.endsWith('.js')?'application/javascript':'text/html'}}));
    };
    await main_frame.navigate_to(origin+'/start');
  },origin);
  const root=page.frames().find(frame=>frame.parentFrame()===page.mainFrame());
  const count=()=>page.evaluate(()=>Object.values(sandstone.controller.iframes).filter(frame=>frame.url.origin==='https://lifecycle.test'&&frame.id!==main_frame.id).length);
  const held=number=>until(()=>page.evaluate(number=>frameLifecycle.signals.length>=number,number),'held requests '+number);
  let unloadCount=0;
  const clean=async(unload=false)=>{
    await until(async()=>await count()===0,'removed frame registrations');
    await until(()=>page.evaluate(()=>frameLifecycle.signals.every(entry=>entry.signal.aborted)),'removed frame requests');
    if(!await root.evaluate(()=>sandstone_frame.loader.child_navigators.size===0&&sandstone_frame.loader.child_names.size===0))throw new Error('Removed frame callbacks remain registered');
    if(!await page.evaluate(()=>main_frame.rpc_target.extra_frame_targets.size===0))throw new Error('Removed frame ports remain attached');
    if(unload){
      unloadCount+=2;
      await until(()=>page.evaluate(count=>frameLifecycle.unload.length>=count,unloadCount),'accepted unload traffic');
    }
    if(!await page.evaluate(()=>frameLifecycle.unload.every(entry=>!entry.signal.aborted)))throw new Error('Removing a frame aborted its unload traffic');
    await page.evaluate(()=>{for(const entry of frameLifecycle.unload)entry.release();});
    await until(()=>page.evaluate(()=>sandstone.network.beacons.pending.size===0&&sandstone.network.keepalives.requests.size===0),'unload completion');
  };
  await evaluate(`globalThis.child=document.createElement('iframe');child.src=${JSON.stringify(origin+'/child')};document.getElementById('mount').append(child);true`);
  await held(3);
  await evaluate('globalThis.oldWindow=child.contentWindow;child.remove();true');
  await clean(true);
  await evaluate("document.getElementById('mount').append(child);true");
  await held(6);
  if(!await evaluate('child.contentWindow!==oldWindow'))throw new Error('Reinserting a frame reused its destroyed Window');
  if(await evaluate('typeof document.getElementById("other").moveBefore==="function"')){
    const before=await page.evaluate(()=>frameLifecycle.requests.length);
    await evaluate('globalThis.movedWindow=child.contentWindow;document.getElementById("other").moveBefore(child,null);true');
    await evaluate('new Promise(resolve=>setTimeout(resolve,30))');
    if(!await evaluate('child.contentWindow===movedWindow')||await page.evaluate(()=>frameLifecycle.requests.length)!==before)throw new Error('A state-preserving iframe move restarted navigation');
  }
  await evaluate(`child.src=${JSON.stringify(origin+'/slow')};true`);await held(7);
  await evaluate('child.remove();true');await clean(true);
  const requests=await page.evaluate(()=>frameLifecycle.requests.length);
  await evaluate(`child.src=${JSON.stringify(origin+'/child')};true`);
  await page.waitForTimeout(30);
  if(await page.evaluate(()=>frameLifecycle.requests.length)!==requests)throw new Error('A detached iframe started a request');
  await evaluate('document.getElementById("mount").append(child);true');await held(10);
  await evaluate('document.getElementById("mount").replaceChildren();true');await clean(true);
  await evaluate(`globalThis.shadowHost=document.createElement('div');document.body.append(shadowHost);const shadow=shadowHost.attachShadow({mode:'closed'});const frame=document.createElement('iframe');frame.src=${JSON.stringify(origin+'/simple')};shadow.append(frame);true`);
  await held(11);await evaluate('shadowHost.remove();true');await clean();
  await evaluate('document.body.append(shadowHost);true');await held(12);
  await evaluate('shadowHost.remove();true');await clean();
  return ['Removing iframe trees cancels requests and releases descendant registrations, ports and callbacks','Reinserted iframes reload authored URLs with fresh Windows while detached URL writes stay idle','State-preserving iframe moves retain active documents','Closed shadow iframe trees retire and reconnect with their hosts','Accepted iframe unload beacons and keepalive requests survive removal'];
}
