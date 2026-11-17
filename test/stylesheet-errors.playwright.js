async (page,allowDiagnostics)=>{
  const origin='https://fixture.test',base=origin+'/stylesheet-errors/';
  const html=href=>'<!doctype html><head><script>window.styleErrors=[];window.setterReturned=false;</script>'+
    '<link id="sheet" rel="stylesheet" href="'+href+'" onerror="styleErrors.push({href:this.href,returned:setterReturned});this.href=\''+base+'good.css\'">'+
    '</head><body><div id="probe">Page survived</div>';
  const response=url=>{
    const target=new URL(url),css=target.pathname.endsWith('.css');
    return {status:target.pathname.endsWith('/missing.css')?404:200,contentType:css?'text/css':'text/html',
      body:css?'#probe{padding-left:'+(target.pathname.endsWith('/other.css')?29:17)+'px}':html(target.searchParams.get('href')||base+'good.css')};
  };
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage();
  await nativeContext.route(base+'**',route=>route.fulfill(response(route.request().url())));
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const read=(proxy,source)=>evaluate(proxy,'JSON.stringify('+source+')').then(JSON.parse);
  const until=async(proxy,expression)=>{
    const deadline=Date.now()+5000;
    while(!await evaluate(proxy,expression)){
      if(Date.now()>deadline)throw new Error('Stylesheet error recovery timed out: '+expression);
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  };
  const run=async proxy=>{
    const results=[];
    for(const href of ['http://[',base+'missing.css',base+'good.css']){
      const url=base+'page?href='+encodeURIComponent(href);
      if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),url);else await native.goto(url);
      if(href==='http://['){
        results.push(await read(proxy,'({errors:styleErrors,href:document.getElementById("sheet").href,padding:getComputedStyle(document.getElementById("probe")).paddingLeft})'));
        await evaluate(proxy,`document.getElementById('sheet').href=${JSON.stringify(base+'good.css')}`);
      }
      try{await until(proxy,'getComputedStyle(document.getElementById("probe")).paddingLeft==="17px"');}
      catch(error){throw new Error(error.message+' '+JSON.stringify({proxy,href,state:await read(proxy,'({html:document.documentElement.outerHTML,errors:styleErrors})')}));}
      if(href.endsWith('/good.css')){
        const threw=await evaluate(proxy,`(()=>{try{document.getElementById('sheet').href='http://[';setterReturned=true;return false;}catch{return true;}})()`);
        if(threw)throw new Error('Invalid stylesheet href threw synchronously');
        await evaluate(proxy,'new Promise(resolve=>setTimeout(resolve,30))');
        results.push(await read(proxy,'({errors:styleErrors,href:document.getElementById("sheet").href,padding:getComputedStyle(document.getElementById("probe")).paddingLeft})'));
        await evaluate(proxy,`document.getElementById('sheet').href=${JSON.stringify(base+'good.css')}`);
        await until(proxy,'getComputedStyle(document.getElementById("probe")).paddingLeft==="17px"');
        await evaluate(proxy,`setterReturned=false;document.getElementById('sheet').href=${JSON.stringify(base+'missing.css')};setterReturned=true;`);
        await until(proxy,'styleErrors.length===1');
        await until(proxy,'getComputedStyle(document.getElementById("probe")).paddingLeft==="17px"');
      }
      results.push(await read(proxy,'({text:document.getElementById("probe").textContent,errors:styleErrors,href:document.getElementById("sheet").href,padding:getComputedStyle(document.getElementById("probe")).paddingLeft})'));
      await evaluate(proxy,`styleErrors=[];const sheet=document.getElementById('sheet');sheet.href='http://[';sheet.href=${JSON.stringify(base+'missing.css')};sheet.href=${JSON.stringify(base+'other.css')};`);
      await until(proxy,'getComputedStyle(document.getElementById("probe")).paddingLeft==="29px"');
      // Allow the superseded HTTP failure's queued error task to run.
      await evaluate(proxy,'new Promise(resolve=>setTimeout(resolve,30))');
      results.push(await read(proxy,'({errors:styleErrors,padding:getComputedStyle(document.getElementById("probe")).paddingLeft})'));
    }
    return results;
  };
  try{
    allowDiagnostics([`Stylesheet failed: ${base}missing.css: Stylesheet request failed: 404`]);
    const expected=await run(false);
    await page.evaluate(({base,htmlSource,responseSource})=>{
      const html=eval('('+htmlSource+')'),response=eval('('+responseSource+')');
      const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=(url,options)=>{
        if(!String(url).startsWith(base))return previous(url,options);
        const result=response(url);
        return Promise.resolve(new Response(result.body,{status:result.status,headers:{'Content-Type':result.contentType}}));
      };
    },{base,htmlSource:html.toString(),responseSource:response.toString()});
    const actual=await run(true);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Stylesheet failure parity: '+JSON.stringify({expected,actual}));
    return ['Invalid stylesheet URLs preserve the page without throwing or firing error','HTTP stylesheet failures run fallback handlers after page initialization'];
  }finally{await nativeContext.close();}
}
