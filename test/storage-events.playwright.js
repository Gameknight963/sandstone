async page=>{
  const base='https://storage-events.test/',other='https://other-storage.test/',parent='<!doctype html><body>Storage events';
  const child='<!doctype html><body>Observer<script>window.storageEvents=[];window.storageStatus={};for(const key of ["localStorage","sessionStorage"]){try{storageStatus[key]=window[key].length>=0?"available":"bad";}catch(error){storageStatus[key]=error.name;}}addEventListener("storage",event=>storageEvents.push({key:event.key,old:event.oldValue,value:event.newValue,url:event.url,area:event.storageArea===localStorage?"local":event.storageArea===sessionStorage?"session":"wrong",instance:event instanceof StorageEvent,target:event.target===window,current:event.currentTarget===window}));parent.postMessage({kind:"storage-observer",url:location.href},"*");'+
    `if(location.pathname==='/opaque'){addEventListener('message',event=>{if(event.data?.kind==='storage-observer')parent.postMessage({...event.data,ancestorOrigin:event.origin},'*');});const nested=document.createElement('iframe');nested.src=${JSON.stringify(base+'opaque-child')};document.body.append(nested);}`+'<\/script>';
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage();
  for(const host of [base,other])await nativeContext.route(host+'**',route=>route.fulfill({contentType:'text/html',body:route.request().url()===base?'<!doctype html><body>Parent':child}));
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const until=async predicate=>{
    const deadline=Date.now()+5000;
    while(!await predicate()){
      if(Date.now()>deadline)throw new Error('Storage event did not arrive');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  };
  const run=async proxy=>{
    if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),base);else await native.goto(base);
    await evaluate(proxy,`window.storageEvents=[];window.storageReady=[];
      addEventListener('storage',event=>storageEvents.push(event.key));
      addEventListener('message',event=>{if(event.data?.kind==='storage-observer')storageReady.push(event.data);});
      localStorage.clear();sessionStorage.clear();
      for(const url of ${JSON.stringify([base+'observer',other+'observer',base+'opaque'])}){const frame=document.createElement('iframe');if(url.endsWith('/opaque'))frame.sandbox='allow-scripts';frame.src=url;document.body.append(frame);}true`);
    await until(()=>evaluate(proxy,'storageReady.length===4'));
    const frames=[];
    for(const url of [base+'observer',other+'observer',base+'opaque',base+'opaque-child'])for(const frame of (proxy?page:native).frames()){
      const matches=proxy?await frame.evaluate(url=>globalThis.sandstone_frame?.loader.url===url,url):frame.url()===url;
      if(matches){frames.push(frame);break;}
    }
    const read=(index,expression)=>frames[index].evaluate(({proxy,expression})=>proxy?sandstone_frame.context.run_script('JSON.stringify('+expression+')'):JSON.stringify(eval(expression)),{proxy,expression}).then(JSON.parse);
    let peer;
    if(proxy)await page.evaluate(async({url,child})=>{
      globalThis.storagePeer=new sandstone.controller.ProxyFrame();document.body.append(storagePeer.iframe);
      storagePeer.special_pages[url]=child;await storagePeer.navigate_to(url);
    },{url:base+'other-page',child});
    else{peer=await nativeContext.newPage();await peer.goto(base+'other-page');}
    const peerRead=expression=>proxy?page.evaluate(expression=>storagePeer.eval_js('JSON.stringify('+expression+')'),expression).then(JSON.parse):peer.evaluate(expression=>JSON.stringify(eval(expression)),expression).then(JSON.parse);
    try{
    if(proxy){
      const peerId=await page.evaluate(()=>storagePeer.id);
      await evaluate(true,`(async()=>{
        const rpc=window.sandstone_frame.rpc,id=window.sandstone_frame.loader.frame_id,token=window.sandstone_frame.loader.beacon_context;
        await rpc.call_procedure(rpc.host,'local_storage',[id,undefined,{type:'set',key:'forged',value:'bad'}]);
        await rpc.call_procedure(rpc.host,'session_storage',[${JSON.stringify(peerId)},undefined,{type:'set',key:'forged',value:'bad',context:token}]);
        await rpc.call_procedure(rpc.host,'storage_disconnect',[${JSON.stringify(peerId)}]);
      })()`);
      if(await evaluate(true,'localStorage.getItem("forged")')!==null||await peerRead('sessionStorage.getItem("forged")')!==null)throw new Error('Storage mutation accepted an unrelated document context');
    }
    await evaluate(proxy,'history.replaceState(null,"","#source");true');
    const expected=[];
    for(const area of ['localStorage','sessionStorage']){
      await evaluate(proxy,`${area}.setItem('key','one');true`);
      await until(async()=>await read(0,'storageEvents.length')===expected.length+1);
      expected.push(area);
      if(await read(0,area+'.getItem("key")')!=='one')throw new Error('Storage observer did not update before its event');
      await evaluate(proxy,`${area}.setItem('key','one');${area}.removeItem('missing');true`);
      await evaluate(proxy,`${area}.setItem('key','two');true`);
      await until(async()=>await read(0,'storageEvents.length')===expected.length+1);expected.push(area);
      await evaluate(proxy,`${area}.removeItem('key');true`);
      await until(async()=>await read(0,'storageEvents.length')===expected.length+1);expected.push(area);
      await evaluate(proxy,`${area}.setItem('other','value');${area}.clear();${area}.clear();true`);
      await until(async()=>await read(0,'storageEvents.length')===expected.length+2);expected.push(area,area);
    }
    await until(async()=>await peerRead('storageEvents.length')===5);
    const result={events:await read(0,'storageEvents'),excluded:await read(1,'storageEvents'),opaque:{events:await read(2,'storageEvents'),access:await read(2,'storageStatus')},source:JSON.parse(await evaluate(proxy,'JSON.stringify(storageEvents)')),otherPage:await peerRead('({events:storageEvents,session:sessionStorage.getItem("key")})')};
    result.opaqueDescendant={events:await read(3,'storageEvents'),access:await read(3,'storageStatus'),origin:await evaluate(proxy,'storageReady.find(event=>event.url.endsWith("/opaque-child")).ancestorOrigin')};
    await evaluate(proxy,'localStorage.setItem("admin","stale");true');
    await until(async()=>await read(0,'localStorage.getItem("admin")')==='stale'&&await peerRead('localStorage.getItem("admin")')==='stale');
    if(proxy)await page.evaluate(()=>sandstone.controller.site_data.clear('storage-events.test'));
    else await evaluate(false,'localStorage.clear();true');
    await until(async()=>await evaluate(proxy,'localStorage.getItem("admin")')===null&&await read(0,'localStorage.getItem("admin")')===null&&await peerRead('localStorage.getItem("admin")')===null);
    result.cleared=true;
    await evaluate(proxy,`addEventListener('pagehide',()=>{localStorage.setItem('retired','saved');sessionStorage.setItem('retired','saved');},{once:true});true`);
    if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),other+'after');else await native.goto(other+'after');
    await until(async()=>await peerRead('localStorage.getItem("retired")')==='saved');
    result.otherOrigin=JSON.parse(await evaluate(proxy,'JSON.stringify({local:localStorage.getItem("retired"),session:sessionStorage.getItem("retired")})'));
    if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),base+'after');else await native.goto(base+'after');
    result.retired=JSON.parse(await evaluate(proxy,'JSON.stringify({local:localStorage.getItem("retired"),session:sessionStorage.getItem("retired")})'));
    return result;
    }finally{
      if(proxy)await page.evaluate(()=>{sandstone.network.clean_ws_connections(storagePeer.id);storagePeer.iframe.remove();storagePeer.rpc_target.target.close();delete sandstone.controller.iframes[storagePeer.id];delete globalThis.storagePeer;});
      else await peer.close();
    }
  };
  try{
    const expected=await run(false);
    await page.evaluate(({base,other,parent,child})=>{
      const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=(url,options)=>String(url).startsWith(base)||String(url).startsWith(other)?Promise.resolve(new Response(url===base?parent:child,{headers:{'Content-Type':'text/html'}})):previous(url,options);
    },{base,other,parent,child});
    const actual=await run(true);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Storage event parity: '+JSON.stringify({expected,actual}));
    return ['Live same-origin storage changes update observers before storage events','Storage events preserve keys, values, source URLs and storageArea identity','Session storage events stay within their top-level browsing context','Opaque documents cannot access Web Storage and cross-origin documents do not receive events','Clearing site data updates open document storage views','Pagehide storage writes retain their original origin across navigation'];
  }finally{await nativeContext.close();}
}
