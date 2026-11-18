async page=>{
  const url='https://locks.test/page',html='<!doctype html><body>Lock coordination';
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage();
  await nativeContext.route('https://locks.test/**',route=>route.fulfill({contentType:'text/html',body:html}));
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const until=async(proxy,source)=>{const end=Date.now()+5000;while(!await evaluate(proxy,source)){if(Date.now()>end)throw new Error('Lock browser fixture timed out: '+source);await new Promise(resolve=>setTimeout(resolve,20));}};
  const run=async proxy=>{
    if(proxy)await page.evaluate(async({url,html})=>{main_frame.special_pages[url]=html;await main_frame.navigate_to(url);},{url,html});else await native.goto(url);
    const local=JSON.parse(await evaluate(proxy,`(async()=>{
      const results={identity:navigator.locks===navigator.locks,tag:Object.prototype.toString.call(navigator.locks)};
      let release,started=false;const first=navigator.locks.request('database',async lock=>{results.lock={name:lock.name,mode:lock.mode,instance:lock instanceof Lock,tag:Object.prototype.toString.call(lock)};await new Promise(resolve=>release=resolve);return 42;});
      while(!release)await new Promise(resolve=>setTimeout(resolve,5));
      const second=navigator.locks.request('database',()=>{started=true;return 'next';});
      let snapshot;do{await new Promise(resolve=>setTimeout(resolve,5));snapshot=await navigator.locks.query();}while(!snapshot.pending.length);
      results.snapshot={held:snapshot.held.map(info=>[info.name,info.mode]),pending:snapshot.pending.map(info=>[info.name,info.mode]),client:!!snapshot.held[0].clientId,sameClient:snapshot.held[0].clientId===snapshot.pending[0].clientId};
      results.queued=!started;results.unavailable=await navigator.locks.request('database',{ifAvailable:true},lock=>lock===null);
      const controller=new AbortController(),reason={exact:'abort'};const aborted=navigator.locks.request('database',{signal:controller.signal},()=>{throw new Error('Aborted callback ran');});
      controller.abort(reason);try{await aborted;}catch(error){results.abortIdentity=error===reason;}
      release();results.values=[await first,await second];
      const value=()=>{};results.valueIdentity=await navigator.locks.request('database',()=>value)===value;
      try{await navigator.locks.request('database',()=>{throw value;});}catch(error){results.errorIdentity=error===value;}
      let readers=0,releaseReaders;const barrier=new Promise(resolve=>releaseReaders=resolve);
      const a=navigator.locks.request('readers',{mode:'shared'},async()=>{readers++;await barrier;});
      const b=navigator.locks.request('readers',{mode:'shared'},async()=>{readers++;await barrier;});
      while(readers!==2)await new Promise(resolve=>setTimeout(resolve,5));results.shared=(await navigator.locks.query()).held.length;releaseReaders();await Promise.all([a,b]);
      let held=false;const stolen=navigator.locks.request('stolen',()=>{held=true;return new Promise(()=>{});}).catch(error=>error.name);
      while(!held)await new Promise(resolve=>setTimeout(resolve,5));await navigator.locks.request('stolen',{steal:true},()=>{});results.stolen=await stolen;
      results.empty=JSON.stringify(await navigator.locks.query());return JSON.stringify(results);
    })()`));
    await evaluate(proxy,`globalThis.lockChildReady=false;globalThis.lockChild=document.createElement('iframe');lockChild.srcdoc='<script>navigator.locks.request("child-owned",()=>{parent.postMessage("child-lock-ready","*");return new Promise(()=>{});});<\\/script>';addEventListener('message',event=>{if(event.data==='child-lock-ready')lockChildReady=true;});document.body.append(lockChild);true`);
    await until(proxy,'lockChildReady');
    const frame=JSON.parse(await evaluate(proxy,`(async()=>{const snapshot=await navigator.locks.query();const distinct=await navigator.locks.request('root-client',async()=>{const all=(await navigator.locks.query()).held;return all[0].clientId!==all[1].clientId;});return JSON.stringify({held:snapshot.held.map(info=>info.name),blocked:await navigator.locks.request('child-owned',{ifAvailable:true},lock=>lock===null),distinct});})()`));
    await evaluate(proxy,'lockChild.remove();true');
    await evaluate(proxy,`navigator.locks.request('child-owned',()=>true)`);
    const worker=JSON.parse(await evaluate(proxy,`(async()=>{
      const source='navigator.locks.request("worker-owned",()=>{postMessage({ready:true,instance:navigator.locks instanceof LockManager});return new Promise(()=>{});});';
      const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'})),worker=new Worker(url);
      try{const ready=await new Promise((resolve,reject)=>{worker.onmessage=event=>resolve(event.data);worker.onerror=event=>reject(new Error(event.message));});
        const blocked=await navigator.locks.request('worker-owned',{ifAvailable:true},lock=>lock===null);worker.terminate();
        const released=await navigator.locks.request('worker-owned',()=>true);return JSON.stringify({...ready,blocked,released});
      }finally{worker.terminate();URL.revokeObjectURL(url);}
    })()`));
    const tab=proxy?await page.context().newPage():await nativeContext.newPage();
    let tabs;
    try{
      if(proxy){
        await tab.route(/^https?:/,route=>route.abort('blockedbyclient'));await tab.goto(page.url());
        await tab.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
        await tab.evaluate(async({url,html})=>{main_frame.special_pages[url]=html;await main_frame.navigate_to(url);},{url,html});
      }else await tab.goto(url);
      await evaluate(proxy,`globalThis.tabLockReady=false;globalThis.tabLock=navigator.locks.request('tab-owned',()=>{tabLockReady=true;return new Promise(resolve=>globalThis.releaseTabLock=resolve);});true`);
      await until(proxy,'tabLockReady');
      const source='navigator.locks.request("tab-owned",{ifAvailable:true},lock=>lock===null)';
      const blocked=proxy?await tab.evaluate(source=>main_frame.eval_js(source),source):await tab.evaluate(source=>eval(source),source);
      await evaluate(proxy,'releaseTabLock();tabLock');tabs={blocked};
    }finally{await tab.close();}
    return {local,frame,worker,tabs};
  };
  try{
    const expected=await run(false),actual=await run(true);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Web Locks differ from native: '+JSON.stringify({expected,actual}));
    return ['Web Locks preserve exclusive/shared scheduling, callback identity, aborts and stealing','Same-origin inline frames and workers share locks and release them on termination','Standalone-file tabs coordinate virtual-origin locks through the host'];
  }finally{await nativeContext.close();}
}
