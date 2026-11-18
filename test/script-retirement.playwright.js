async page=>{
  const origin='https://script-retirement.test',context=await page.context().browser().newContext(),native=await context.newPage(),direct=[];
  const html='<!doctype html><body><script>globalThis.retirementLog=[];</script>',source=id=>`retirementLog.push(${JSON.stringify(id)});`;
  let requests=[],release;
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const until=async predicate=>{const end=Date.now()+5000;while(!await predicate()){if(Date.now()>end)throw new Error('Script retirement timed out');await new Promise(resolve=>setTimeout(resolve,10));}};
  const block=route=>{direct.push(route.request().url());return route.abort();};
  const run=async(proxy,mode)=>{
    requests=[];release=undefined;
    if(proxy){await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');await page.evaluate(()=>{globalThis.retirementRequests=[];delete globalThis.releaseRetirement;});}else await native.goto(origin+'/start');
    await evaluate(proxy,`(()=>{for(const id of ['first','second']){const script=document.createElement('script');script.id=id;${mode==='async replacement'?'':'script.async=false;'}script.src='/'+id+'.js';document.body.append(script);}})()`);
    await until(()=>proxy?page.evaluate(()=>retirementRequests.includes('second')):requests.includes('second'));
    if(mode==='adopt')await evaluate(proxy,`document.implementation.createHTMLDocument('').adoptNode(document.getElementById('first'));undefined;`);
    else{
      if(mode==='async replacement')await until(()=>evaluate(proxy,'retirementLog.includes("second")'));
      const replacement='<!doctype html><body><script>retirementLog=["replacement"];const script=document.createElement("script");script.async=false;script.src="/third.js";document.body.append(script);</script>';
      await evaluate(proxy,`document.open();document.write(${JSON.stringify(replacement)});document.close();`);
    }
    if(proxy)await page.evaluate(()=>releaseRetirement());else release();
    await until(()=>evaluate(proxy,mode==='adopt'?'retirementLog.includes("second")':'retirementLog.includes("third")'));
    await new Promise(resolve=>setTimeout(resolve,100));
    return evaluate(proxy,mode==='async replacement'?'JSON.stringify([...retirementLog].sort())':'JSON.stringify(retirementLog)');
  };
  try{
    await native.route(origin+'/**',async route=>{const url=new URL(route.request().url()),id=url.pathname.slice(1,-3);if(!url.pathname.endsWith('.js'))return route.fulfill({contentType:'text/html',body:html});requests.push(id);if(id==='first')await new Promise(resolve=>release=resolve);await route.fulfill({contentType:'text/javascript',body:source(id)});});
    await page.route(/^https?:/,block);
    await page.evaluate(({origin,html})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=async(url,options)=>{if(new URL(url).origin!==origin)return previous(url,options);const target=new URL(url),id=target.pathname.slice(1,-3);if(!target.pathname.endsWith('.js'))return new Response(html,{headers:{'Content-Type':'text/html'}});retirementRequests.push(id);if(id==='first')await new Promise(resolve=>globalThis.releaseRetirement=resolve);return new Response('retirementLog.push('+JSON.stringify(id)+');',{headers:{'Content-Type':'text/javascript'}});};},{origin,html});
    const failures=[];
    for(const mode of ['adopt','ordered replacement','async replacement']){const expected=await run(false,mode),actual=await run(true,mode);if(actual!==expected)failures.push({mode,expected,actual});}
    if(failures.length)throw new Error('Retired script execution differs: '+JSON.stringify(failures));
    if(direct.length)throw new Error('Retired scripts attempted direct HTTP: '+JSON.stringify(direct));
    return ['Adopted prepared scripts cannot execute in their previous document','Document.open preserves prepared scripts and native ordering in the same Document'];
  }finally{release?.();await context.close();await page.unroute(/^https?:/,block);}
}
