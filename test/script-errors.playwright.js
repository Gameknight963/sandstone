async (page,allowDiagnostics)=>{
  const base='https://fixture.test/script-errors/';
  const kinds=['classic','module','dependency','invalid-classic','invalid-module'];
  const pages={},sources={};
  for(const kind of kinds){
    const src=kind.startsWith('invalid-')?'http://[':base+(kind==='dependency'?'entry.mjs':'missing-'+kind+'.js');
    const type=kind.endsWith('classic')?'':'module';
    pages[base+'page-'+kind]='<!doctype html><head><script>'+`
      window.scriptErrors=[];window.fallbackLoads=0;window.setterReturned=false;
      window.recoverScript=(element,type)=>{
        scriptErrors.push({src:element.src,returned:setterReturned});
        const fallback=document.createElement('script');fallback.type=type;
        fallback.src=${JSON.stringify(base+'fallback.js?attempt=')}+scriptErrors.length;document.head.append(fallback);
      };
    `+'</script><script type="'+type+'" src="'+src+'" onerror="recoverScript(this,\''+type+'\')"></script></head><body><div id="probe">Page survived</div>';
  }
  sources[base+'entry.mjs']="import './missing-dependency.mjs';window.failedModuleExecuted=true;";
  sources[base+'fallback.js?attempt=1']=sources[base+'fallback.js?attempt=2']='window.fallbackLoads++;';
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage();
  await nativeContext.route(base+'**',route=>{
    const url=route.request().url();
    return route.fulfill({status:url in pages||url in sources?200:404,contentType:url in pages?'text/html':'text/javascript',body:pages[url]||sources[url]||''});
  });
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const read=(proxy,source)=>evaluate(proxy,'JSON.stringify('+source+')').then(JSON.parse);
  const until=async(proxy,expression)=>{
    const deadline=Date.now()+5000;
    while(!await evaluate(proxy,expression)){
      if(Date.now()>deadline)throw new Error('Script recovery timed out: '+JSON.stringify({proxy,expression,state:await read(proxy,'({errors:scriptErrors,loads:fallbackLoads,text:document.body?.textContent})')}));
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  };
  const run=async proxy=>{
    const results=[];
    for(const kind of kinds){
      const url=base+'page-'+kind;
      if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),url);else await native.goto(url);
      await until(proxy,'fallbackLoads===1');
      results.push(await read(proxy,'({errors:scriptErrors,loads:fallbackLoads,text:document.getElementById("probe").textContent,failedModuleExecuted:!!window.failedModuleExecuted})'));
      const type=kind.endsWith('classic')?'':'module';
      await evaluate(proxy,`setterReturned=false;const script=document.createElement('script');script.type=${JSON.stringify(type)};
        script.onerror=()=>recoverScript(script,${JSON.stringify(type)});script.src=${JSON.stringify(base+'missing-dynamic-'+kind+'.js')};
        document.head.append(script);setterReturned=true;`);
      await until(proxy,'fallbackLoads===2');
      results.push(await read(proxy,'({errors:scriptErrors,loads:fallbackLoads})'));
    }
    return results;
  };
  try{
    const expected=await run(false);
    const invalidMessage=await native.evaluate(()=>{try{new URL('http://[');}catch(error){return error.message;}});
    await page.evaluate(({base,pages,sources})=>{
      const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=(url,options)=>{
        if(!String(url).startsWith(base))return previous(url,options);
        return Promise.resolve(new Response(pages[url]||sources[url]||'',{status:url in pages||url in sources?200:404,headers:{'Content-Type':url in pages?'text/html':'text/javascript'}}));
      };
    },{base,pages,sources});
    allowDiagnostics([
      `Script failed: ${base}missing-classic.js: Script request failed: 404`,
      `Script failed: ${base}missing-dynamic-classic.js: Script request failed: 404`,
      `Script failed: ${base}missing-dynamic-invalid-classic.js: Script request failed: 404`,
      `Script failed: http://[: ${invalidMessage}`,
      ...['module','dynamic-module','dynamic-dependency','dynamic-invalid-module'].map(kind=>`Script failed: ${base}missing-${kind}.js: Module request failed (404): ${base}missing-${kind}.js`),
      `Script failed: ${base}entry.mjs: Module request failed (404): ${base}missing-dependency.mjs`
    ]);
    const actual=await run(true);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Script failure parity: '+JSON.stringify({expected,actual}));
    return ['Initial classic/module script failures run page fallback handlers','Failed module dependencies and dynamic script failures recover without executing failed graphs'];
  }finally{await nativeContext.close();}
}
