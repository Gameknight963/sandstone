async page=>{
  const base='https://fixture.test/script-attributes/';
  const html=module=>'<!doctype html><head><script>window.scriptExecutions=[];window.scriptLoads=0;</script><script id="resource" '+(module?'type="module" ':'')+'src="./one.'+(module?'mjs':'js')+'"></script></head><body>Script detection';
  const source=path=>`scriptExecutions.push({file:${JSON.stringify(path.split('/').at(-1))},current:document.currentScript?.getAttribute('src')??null});`;
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage();
  const nativeRequests=[];let releaseNative;
  await nativeContext.route(base+'**',async route=>{
    const url=new URL(route.request().url());nativeRequests.push(url.pathname);
    if(url.pathname.includes('/slow.'))await new Promise(resolve=>releaseNative=resolve);
    const script=/\.m?js$/.test(url.pathname);
    await route.fulfill({contentType:script?'text/javascript':'text/html',body:script?source(url.pathname):html(url.pathname.endsWith('/module'))});
  });
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const read=(proxy,source)=>evaluate(proxy,'JSON.stringify('+source+')').then(JSON.parse);
  const until=async(proxy,expression)=>{
    const deadline=Date.now()+5000;
    while(!await evaluate(proxy,expression)){
      if(Date.now()>deadline)throw new Error('Script attributes timed out: '+JSON.stringify({proxy,expression,state:await read(proxy,'({executions:scriptExecutions,loads:scriptLoads})')}));
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  };
  const run=async proxy=>{
    const values=[];
    for(const module of [false,true]){
      const extension=module?'mjs':'js',url=base+(module?'module':'classic');
      if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),url);else await native.goto(url);
      await until(proxy,'scriptExecutions.length===1');
      const snapshot='({raw:document.getElementById("resource").getAttribute("SRC"),has:document.getElementById("resource").hasAttribute("src"),src:document.getElementById("resource").src,executions:scriptExecutions})';
      values.push(await read(proxy,snapshot));
      values.push(await read(proxy,`({found:Array.from(document.scripts).some(script=>script.getAttribute('src')==='./one.${extension}')})`));
      await evaluate(proxy,`document.getElementById('resource').setAttribute('SRC','./two.${extension}')`);
      values.push(await read(proxy,snapshot));
      await evaluate(proxy,'document.getElementById("resource").removeAttribute("src")');
      values.push(await read(proxy,snapshot));
      await evaluate(proxy,'document.getElementById("resource").src=""');
      values.push(await read(proxy,snapshot));
      releaseNative=undefined;if(proxy)await page.evaluate(()=>delete globalThis.releaseScriptAttribute);
      await evaluate(proxy,`const script=document.createElement('script');script.id='pending';${module?"script.type='module';":''}script.onload=()=>scriptLoads++;script.src='./slow.${extension}';document.head.append(script);`);
      if(proxy)await page.waitForFunction(()=>typeof releaseScriptAttribute==='function');
      else{const deadline=Date.now()+5000;while(!releaseNative){if(Date.now()>deadline)throw new Error('Native script request did not start');await new Promise(resolve=>setTimeout(resolve,20));}}
      await evaluate(proxy,`document.getElementById('pending').src='./two.${extension}';document.getElementById('pending').removeAttribute('src');`);
      if(proxy)await page.evaluate(()=>releaseScriptAttribute());else releaseNative();
      await until(proxy,'scriptLoads===1');
      values.push(await read(proxy,'({executions:scriptExecutions,raw:document.getElementById("pending").getAttribute("src"),src:document.getElementById("pending").src})'));
    }
    return values;
  };
  try{
    const expected=await run(false);
    await page.evaluate(({base,htmlSource,sourceSource})=>{
      const html=eval('('+htmlSource+')'),source=eval('('+sourceSource+')'),previous=sandstone.network.session.fetch;
      globalThis.scriptAttributeRequests=[];
      sandstone.network.session.fetch=async(url,options)=>{
        if(!String(url).startsWith(base))return previous(url,options);
        const path=new URL(url).pathname;scriptAttributeRequests.push(path);
        if(path.includes('/slow.'))await new Promise(resolve=>globalThis.releaseScriptAttribute=resolve);
        const script=/\.m?js$/.test(path);
        return new Response(script?source(path):html(path.endsWith('/module')),{headers:{'Content-Type':script?'text/javascript':'text/html'}});
      };
    },{base,htmlSource:html.toString(),sourceSource:source.toString()});
    const actual=await run(true),requests=await page.evaluate(()=>scriptAttributeRequests);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Script attribute parity: '+JSON.stringify({expected,actual}));
    if(requests.some(path=>path.includes('/two.'))||nativeRequests.some(path=>path.includes('/two.')))throw new Error('An already started script fetched a replacement src: '+JSON.stringify({nativeRequests,requests}));
    return ['Classic/module script src attributes retain authored URLs for resource detection','Script src changes and removals after preparation preserve the original execution without redundant requests'];
  }finally{await nativeContext.close();}
}
