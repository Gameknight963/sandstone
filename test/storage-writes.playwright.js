async page=>{
  const base='https://storage-write.test/storage-mutations/',url=base+'page';
  const parent='<!doctype html><body>Storage writes';
  const child='<!doctype html><body>Storage client<script>parent.postMessage({kind:"storage-ready",path:location.pathname},"*");<\/script>';
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage();
  await nativeContext.route(base+'**',route=>route.fulfill({contentType:'text/html',body:route.request().url()===url?parent:child}));
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const until=async predicate=>{
    const deadline=Date.now()+5000;
    while(!await predicate()){
      if(Date.now()>deadline)throw new Error('Storage client did not become ready');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  };
  const navigate=proxy=>proxy?page.evaluate(url=>main_frame.navigate_to(url),url):native.goto(url);
  const clients=async proxy=>{
    await evaluate(proxy,`window.storageReady=[];addEventListener('message',event=>{if(event.data?.kind==='storage-ready')storageReady.push(event.data.path);});
      for(const name of ['left','right']){const frame=document.createElement('iframe');frame.src=${JSON.stringify(base)}+name;document.body.append(frame);}true`);
    await until(()=>evaluate(proxy,'storageReady.length===2'));
    const found=[];
    for(const name of ['left','right']){
      for(const frame of (proxy?page:native).frames()){
        const matches=proxy?await frame.evaluate(url=>globalThis.sandstone_frame?.loader.url===url,base+name):frame.url()===base+name;
        if(matches){found.push(frame);break;}
      }
    }
    if(found.length!==2)throw new Error('Storage child frames are missing');
    return found.map(frame=>source=>frame.evaluate(({proxy,source})=>proxy?sandstone_frame.context.run_script(source):eval(source),{proxy,source}));
  };
  const snapshot=proxy=>evaluate(proxy,`JSON.stringify({local:Object.entries(localStorage).sort(),session:Object.entries(sessionStorage).sort()})`).then(JSON.parse);
  const run=async proxy=>{
    const values=[];
    await navigate(proxy);
    await evaluate(proxy,`localStorage.clear();sessionStorage.clear();localStorage.setItem('seed','1');sessionStorage.setItem('seed','1');true`);
    let [left,right]=await clients(proxy);
    await left(`localStorage.setItem('left','A');sessionStorage.setItem('left','A');true`);
    await right(`localStorage.setItem('right','B');sessionStorage.setItem('right','B');true`);
    await navigate(proxy);values.push(await snapshot(proxy));
    [left,right]=await clients(proxy);
    await left(`localStorage.removeItem('left');sessionStorage.removeItem('left');true`);
    await right(`localStorage.setItem('right','updated');sessionStorage.setItem('right','updated');true`);
    await navigate(proxy);values.push(await snapshot(proxy));
    [left,right]=await clients(proxy);
    await left(`localStorage.setItem('fresh','temporary');sessionStorage.setItem('fresh','temporary');true`);
    // Both clients began without this key: removing it must still reach the host.
    await right(`localStorage.removeItem('fresh');sessionStorage.removeItem('fresh');true`);
    await navigate(proxy);values.push(await snapshot(proxy));
    [left,right]=await clients(proxy);
    if(proxy)await page.evaluate(()=>sandstone.controller.site_data.clear('storage-write.test'));
    else await evaluate(false,'localStorage.clear();true');
    await left(`localStorage.setItem('after-clear','new');sessionStorage.clear();true`);
    await right(`sessionStorage.setItem('after-clear','new');true`);
    await navigate(proxy);values.push(await snapshot(proxy));
    return values;
  };
  try{
    const expected=await run(false);
    await page.evaluate(({base,url,parent,child})=>{
      const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=(target,options)=>String(target).startsWith(base)?Promise.resolve(new Response(target===url?parent:child,{headers:{'Content-Type':'text/html'}})):previous(target,options);
    },{base,url,parent,child});
    const actual=await run(true);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Concurrent storage write parity: '+JSON.stringify({expected,actual}));
    return ['Concurrent same-origin localStorage/sessionStorage writes preserve independent keys','Stale storage clients cannot resurrect removed or user-cleared data'];
  }finally{await nativeContext.close();}
}
