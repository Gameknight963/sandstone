async page=>{
  const parentURL='https://rpc-source.test/parent',childURL='https://rpc-child.test/child',replacementURL='https://rpc-next.test/new';
  const evaluate=source=>page.evaluate(source=>main_frame.eval_js(source),source);
  const until=async predicate=>{const deadline=Date.now()+10000;while(!await predicate()){if(Date.now()>deadline)throw new Error('RPC source fixture timed out');await new Promise(resolve=>setTimeout(resolve,20));}};
  await page.evaluate(async({parentURL,childURL,replacementURL})=>{
    const previous=sandstone.network.session.fetch;globalThis.rpcSourceRequests=[];
    sandstone.network.session.fetch=(url,options)=>{
      if(![parentURL,childURL,replacementURL].some(value=>new URL(value).origin===new URL(url).origin))return previous(url,options);
      rpcSourceRequests.push({url,headers:options.headers});
      return Promise.resolve(new Response('<!doctype html><body>RPC source<script>parent.postMessage({rpcSource:location.href},"*");<\/script>',{headers:{'Content-Type':'text/html'}}));
    };
    main_frame.special_pages[parentURL]='<!doctype html><body>RPC parent';await main_frame.navigate_to(parentURL);
  },{parentURL,childURL,replacementURL});
  await evaluate(`document.cookie='rootOwn=one; Path=/';globalThis.arrivals=[];addEventListener('message',event=>{if(event.data?.rpcSource)arrivals.push(event.data.rpcSource);});globalThis.child=document.createElement('iframe');child.src=${JSON.stringify(childURL)};document.body.append(child);true`);
  await until(()=>evaluate('arrivals.length===1'));
  const child=page.frames().find(frame=>frame.parentFrame()?.parentFrame()===page.mainFrame());
  const ids=await page.evaluate(childURL=>{const entry=Object.values(sandstone.controller.iframes).find(frame=>frame.url?.href===childURL);return {root:main_frame.id,child:entry.id,rootToken:main_frame.document_context,oldToken:entry.document_context};},childURL);
  const rejected=await child.evaluate(async ids=>{
    const rpc=sandstone_frame.rpc;
    const cases=[['idb_databases',[ids.root]],['cache_command',[ids.root,{}]],['history_go',[ids.root,-1]],['cookie_set',[ids.root,'forged=one','https://rpc-source.test/']],['crypto',[ids.root,'digest',[]]],['beacon',[ids.rootToken,'https://rpc-source.test/forged',new Blob(['forged'])]],['storage_ready',[ids.root,ids.rootToken]],['local_storage',[ids.root,[],{context:ids.rootToken,type:'set',key:'forged',value:'one'}]],['frame_unregister',[ids.root]],['frame_register',[ids.root,'forged','https://forged.test/']],['fetch',[ids.root,'forged','https://rpc-source.test/forged',{mode:'navigate'}]]];
    const result=[];
    for(const [name,args] of cases){try{await rpc.call_procedure(rpc.host,name,args);result.push(name+':accepted');}catch(error){result.push(error.name);}}
    const channel=new MessageChannel();rpc.attach_host(channel.port1,ids.root);channel.port2.close();
    for(const bridge of rpc.host.extra_targets)bridge.postMessage({type:'procedure',id:'parent-eval',procedure:'eval',arguments:['globalThis.rpcSourceParentForged=true']});
    rpc.host.postMessage({type:'notification',procedure:'cookie_set',arguments:[ids.root,'forgedNotification=one']});
    sandstone_frame.context.run_script("document.cookie='childOwn=one; SameSite=None; Secure; Path=/'");
    if(!Array.isArray(await rpc.call_procedure(rpc.host,'idb_databases',[ids.child])))throw new Error('Own database access failed');
    return result;
  },ids);
  if(rejected.some(name=>name!=='SecurityError'))throw new Error('Cross-source RPC was accepted: '+JSON.stringify(rejected));
  if(await evaluate("document.cookie.includes('forged')"))throw new Error('A child changed its parent cookies');
  if(await evaluate('globalThis.rpcSourceParentForged===true'))throw new Error('A child invoked its parent over the installation reply channel');
  await until(()=>page.evaluate(childURL=>sandstone.controller.site_data.cookies.getCookieStringSync(childURL).includes('childOwn=one'),childURL));
  await page.evaluate(()=>{
    const target=main_frame.rpc_target,post=target.postMessage;
    target.postMessage=function(message,...args){if(message.procedure==='eval')globalThis.rootPendingID=message.id;return Reflect.apply(post,this,[message,...args]);};
    globalThis.restoreRPCPost=()=>target.postMessage=post;
    globalThis.pendingRoot=main_frame.eval_js('new Promise(resolve=>{globalThis.releaseRPCSource=resolve;})').then(value=>globalThis.rootReply=value);
  });
  const pendingID=await page.evaluate(()=>rootPendingID);
  await child.evaluate(id=>sandstone_frame.rpc.host.postMessage({type:'reply',id,content:{success:true,value:'forged'}}),pendingID);
  await page.waitForTimeout(30);
  if(await page.evaluate(()=>globalThis.rootReply!==undefined))throw new Error('A child forged another endpoint reply');
  const root=child.parentFrame();await root.evaluate(()=>sandstone_frame.context.run_script('releaseRPCSource("original")'));
  await page.evaluate(async()=>{await pendingRoot;if(rootReply!=='original')throw new Error('Original endpoint reply was lost');restoreRPCPost();});
  await page.evaluate(()=>{
    globalThis.retiredPortReady=new Promise(resolve=>{const receive=event=>{if(event.data!=='rpc-source-port')return;removeEventListener('message',receive);globalThis.retiredRPCPort=event.ports[0];retiredRPCPort.start();resolve();};addEventListener('message',receive);});
  });
  await child.evaluate(()=>parent.parent.postMessage('rpc-source-port','*',[sandstone_frame.rpc.host.target]));
  await page.evaluate(()=>retiredPortReady);
  await page.evaluate(({id,url})=>sandstone.controller.iframes[id].navigate_to(url),{id:ids.child,url:replacementURL});
  await until(()=>evaluate('arrivals.length===2'));
  if(!await evaluate("document.cookie.includes('rootOwn=one')"))throw new Error('Child navigation replaced its parent cookie snapshot');
  const newToken=await page.evaluate(id=>sandstone.controller.iframes[id].document_context,ids.child);
  const retired=await page.evaluate(async({ids,newToken,childURL,replacementURL})=>{
    const call=(procedure,args)=>new Promise((resolve,reject)=>{
      const id=crypto.randomUUID(),timer=setTimeout(()=>{retiredRPCPort.removeEventListener('message',receive);reject(new Error('Retired RPC did not reply: '+procedure));},3000);
      const receive=event=>{if(event.data?.id!==id)return;clearTimeout(timer);retiredRPCPort.removeEventListener('message',receive);event.data.content.success?resolve(event.data.content.value):reject(event.data.content.value);};
      retiredRPCPort.addEventListener('message',receive);retiredRPCPort.postMessage({type:'procedure',procedure,id,arguments:args});
    });
    const denied=async(procedure,args)=>{try{await call(procedure,args);return 'accepted';}catch(error){return error.name;}};
    const result=[await denied('beacon',[newToken,childURL+'/forged',new Blob(['forged'])]),await denied('local_storage',[ids.child,[],{context:newToken,type:'set',key:'forged',value:'one'}]),await denied('cookie_set',[ids.child,'wrongSite=one',replacementURL])];
    await call('cookie_set',[ids.child,'oldSite=one; SameSite=None; Secure; Path=/',childURL]);
    const accepted=await call('beacon',[ids.oldToken,childURL+'/late',new Blob(['late'])]);
    result.push(!!accepted?.cookies?.cookies.some(cookie=>cookie.key==='oldSite'));
    retiredRPCPort.close();return result;
  },{ids,newToken,childURL,replacementURL});
  if(JSON.stringify(retired)!==JSON.stringify(['SecurityError','SecurityError','SecurityError',true]))throw new Error('Retired RPC context authorization failed: '+JSON.stringify(retired));
  await until(()=>page.evaluate(childURL=>rpcSourceRequests.some(request=>request.url===childURL+'/late'),childURL));
  const cookies=await page.evaluate(({childURL,replacementURL})=>({old:sandstone.controller.site_data.cookies.getCookieStringSync(childURL),next:sandstone.controller.site_data.cookies.getCookieStringSync(replacementURL)}),{childURL,replacementURL});
  if(!cookies.old.includes('oldSite=one')||cookies.next.includes('wrongSite')||cookies.next.includes('oldSite'))throw new Error('Retired cookie writes used the replacement document');
  return ['RPC ports reject cross-frame IDs, document tokens, notifications and channel replacement','RPC replies require the original sending endpoint','Retired RPC channels preserve original cookies and beacon leases while rejecting replacement tokens'];
}
