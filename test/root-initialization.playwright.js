async page=>{
  await page.evaluate(()=>{
    const fetch=sandstone.network.session.fetch,onLoad=main_frame.on_load;
    globalThis.rootInitialization={loads:[],errors:[],restore(){sandstone.network.session.fetch=fetch;main_frame.on_load=onLoad;}};
    main_frame.on_load=()=>rootInitialization.loads.push(main_frame.url.href);
    sandstone.network.session.fetch=async(url,options)=>{
      const path=new URL(url).pathname;
      if(!path.startsWith('/root-initialization/'))return fetch(url,options);
      if(path.endsWith('/held.js')){
        await new Promise(resolve=>rootInitialization.releaseScript=resolve);
        return new Response('window.slowScriptFinished=true;',{headers:{'Content-Type':'application/javascript'}});
      }
      if(path.includes('/next'))await new Promise(resolve=>rootInitialization.releaseNext=resolve);
      return new Response(path.includes('/first')?
        '<!doctype html><title>First document</title><script src="/root-initialization/held.js?case='+encodeURIComponent(path)+'"></script><body>First document':
        '<!doctype html><title>Current document</title><body>Current document',{headers:{'Content-Type':'text/html'}});
    };
    main_frame.navigate_to('https://fixture.test/root-initialization/first').then(()=>rootInitialization.firstDone=true).catch(error=>rootInitialization.errors.push(error.message));
  });
  try{
    await page.waitForFunction(()=>!!rootInitialization.releaseScript);
    await page.evaluate(()=>{main_frame.navigate_to('https://fixture.test/root-initialization/next').then(()=>rootInitialization.nextDone=true).catch(error=>rootInitialization.errors.push(error.message));});
    await page.waitForFunction(()=>!!rootInitialization.releaseNext);
    // The old document has not replied, and the next response is also held.
    // Superseding navigation must settle the obsolete initialization itself.
    await page.waitForFunction(()=>rootInitialization.firstDone,null,{timeout:3000});
    let state=await page.evaluate(()=>({loading:main_frame.is_navigating,loads:rootInitialization.loads,errors:rootInitialization.errors}));
    if(!state.loading||state.loads.length||state.errors.length)throw new Error('Superseded initialization affected the latest navigation: '+JSON.stringify(state));
    await page.evaluate(()=>rootInitialization.releaseScript());
    await page.waitForTimeout(50);
    state=await page.evaluate(()=>({loading:main_frame.is_navigating,loads:rootInitialization.loads,errors:rootInitialization.errors}));
    if(!state.loading||state.loads.length||state.errors.length)throw new Error('A late initialization reply finished the latest navigation: '+JSON.stringify(state));
    await page.evaluate(()=>rootInitialization.releaseNext());
    await page.waitForFunction(()=>rootInitialization.nextDone&&!main_frame.is_navigating);
    const title=await page.evaluate(()=>main_frame.eval_js('document.title'));
    if(title!=='Current document')throw new Error('The latest navigation lost its document: '+title);
    state=await page.evaluate(()=>({loads:rootInitialization.loads,errors:rootInitialization.errors}));
    if(JSON.stringify(state)!==JSON.stringify({loads:['https://fixture.test/root-initialization/next'],errors:[]}))throw new Error('Unexpected initialization callbacks: '+JSON.stringify(state));
    await page.evaluate(()=>{
      const target=main_frame.rpc_target,post=target.postMessage;
      rootInitialization.restorePost=()=>{target.postMessage=post;};
      rootInitialization.loads=[];rootInitialization.firstDone=false;rootInitialization.nextDone=false;
      delete rootInitialization.releaseNext;
      target.postMessage=function(message,...args){
        if(message.procedure==='html'&&message.arguments[0].url==='https://fixture.test/root-initialization/error'){
          if(message.arguments[0].error){rootInitialization.errorReply=message.id;return;}
          queueMicrotask(()=>target.onmessage({data:{type:'reply',id:message.id,content:{success:false,value:new Error('Initialization failed')}}},target));
          return;
        }
        return Reflect.apply(post,this,[message,...args]);
      };
      main_frame.navigate_to('https://fixture.test/root-initialization/error').then(()=>rootInitialization.firstDone=true).catch(error=>rootInitialization.errors.push(error.message));
    });
    await page.waitForFunction(()=>!!rootInitialization.errorReply);
    await page.evaluate(()=>{main_frame.navigate_to('https://fixture.test/root-initialization/next-error').then(()=>rootInitialization.nextDone=true).catch(error=>rootInitialization.errors.push(error.message));});
    await page.waitForFunction(()=>!!rootInitialization.releaseNext);
    await page.waitForFunction(()=>rootInitialization.firstDone,null,{timeout:3000});
    await page.evaluate(()=>rootInitialization.releaseNext());
    await page.waitForFunction(()=>rootInitialization.nextDone&&!main_frame.is_navigating);
    await page.evaluate(()=>main_frame.rpc_target.onmessage({data:{type:'reply',id:rootInitialization.errorReply,content:{success:true}}},main_frame.rpc_target));
    state=await page.evaluate(()=>({loads:rootInitialization.loads,errors:rootInitialization.errors}));
    if(JSON.stringify(state)!==JSON.stringify({loads:['https://fixture.test/root-initialization/next-error'],errors:[]}))throw new Error('An obsolete error page affected the latest navigation: '+JSON.stringify(state));
    await page.evaluate(()=>{
      rootInitialization.loads=[];rootInitialization.firstDone=false;rootInitialization.nextDone=false;
      delete rootInitialization.releaseScript;
      main_frame.navigate_to('https://fixture.test/root-initialization/first-immediate').then(()=>rootInitialization.firstDone=true).catch(error=>rootInitialization.errors.push(error.message));
    });
    await page.waitForFunction(()=>!!rootInitialization.releaseScript);
    await page.evaluate(()=>{main_frame.navigate_to('https://fixture.test/root-initialization/final').then(()=>rootInitialization.nextDone=true).catch(error=>rootInitialization.errors.push(error.message));});
    await page.waitForFunction(()=>rootInitialization.firstDone&&rootInitialization.nextDone&&!main_frame.is_navigating);
    state=await page.evaluate(()=>({loads:rootInitialization.loads,errors:rootInitialization.errors}));
    if(JSON.stringify(state)!==JSON.stringify({loads:['https://fixture.test/root-initialization/final'],errors:[]}))throw new Error('A blocked old script prevented the replacement document: '+JSON.stringify(state));
    return ['Superseded top-level document RPCs settle without waiting for scripts', 'Late initialization replies cannot complete the current navigation', 'Superseded error-page RPCs cancel without rejecting the old navigation', 'Replacement documents load while an old script response is still held'];
  }finally{await page.evaluate(()=>{rootInitialization.releaseScript?.();rootInitialization.releaseNext?.();rootInitialization.restorePost?.();rootInitialization.restore();});}
}
