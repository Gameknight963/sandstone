async page=>{
  const base='https://fixture.test/stylesheet-attributes/';
  const html='<!doctype html><link rel="stylesheet" href="./one.css"><body><div id="probe">Resource detection</div>';
  const css=path=>'#probe{padding-left:'+(path.endsWith('two.css')?29:17)+'px}';
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage();
  let releaseNative;
  await nativeContext.route(base+'**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname.endsWith('slow.css'))await new Promise(resolve=>releaseNative=resolve);
    await route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'text/html',body:url.pathname.endsWith('.css')?css(url.pathname):html});
  });
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const read=(proxy,source)=>evaluate(proxy,'JSON.stringify('+source+')').then(JSON.parse);
  const until=async(proxy,expression)=>{
    const deadline=Date.now()+5000;
    while(!await evaluate(proxy,expression)){
      if(Date.now()>deadline)throw new Error('Stylesheet attributes timed out: '+expression);
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  };
  const run=async proxy=>{
    if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),base+'page');else await native.goto(base+'page');
    await until(proxy,'getComputedStyle(document.getElementById("probe")).paddingLeft==="17px"');
    const snapshot='({raw:document.querySelector("link").getAttribute("HREF"),has:document.querySelector("link").hasAttribute("href"),href:document.querySelector("link").href,padding:getComputedStyle(document.getElementById("probe")).paddingLeft})';
    const values=[await read(proxy,snapshot)];
    values.push(await read(proxy,`(()=>{
      // Chunk loaders scan existing link attributes before inserting more CSS.
      const known=Array.from(document.getElementsByTagName('link')).find(link=>link.rel==='stylesheet'&&(link.getAttribute('data-href')||link.getAttribute('href'))==='./one.css');
      const link=document.querySelector('link'),other=document.createElement('a');other.setAttribute('href','borrowed');
      let names=0;const name={toString(){names++;return 'HREF';}};
      const raw=link.getAttribute(name),borrowed=link.getAttribute.call(other,'href');
      const arity=[];for(const method of ['getAttribute','hasAttribute','removeAttribute','setAttribute']){try{link[method]();arity.push(false);}catch(error){arity.push(error instanceof TypeError);}}
      return {found:!!known,raw,borrowed,names,arity};
    })()`));
    await evaluate(proxy,'document.querySelector("link").removeAttribute("HREF")');
    await until(proxy,'getComputedStyle(document.getElementById("probe")).paddingLeft==="0px"');
    values.push(await read(proxy,snapshot));
    await evaluate(proxy,`document.querySelector('link').setAttribute('href','./two.css')`);
    await until(proxy,'getComputedStyle(document.getElementById("probe")).paddingLeft==="29px"');
    values.push(await read(proxy,snapshot));
    await evaluate(proxy,'document.querySelector("link").href=""');
    await until(proxy,'getComputedStyle(document.getElementById("probe")).paddingLeft==="0px"');
    values.push(await read(proxy,snapshot));
    for(const operation of ['remove','empty','invalid']){
      releaseNative=undefined;
      if(proxy)await page.evaluate(()=>delete globalThis.releaseStyleHref);
      await evaluate(proxy,`window.pendingStyleLoads=0;const link=document.querySelector('link');link.onload=()=>pendingStyleLoads++;link.href='./slow.css';`);
      if(proxy)await page.waitForFunction(()=>typeof releaseStyleHref==='function');
      else{const deadline=Date.now()+5000;while(!releaseNative){if(Date.now()>deadline)throw new Error('Native CSS request did not start');await new Promise(resolve=>setTimeout(resolve,20));}}
      await evaluate(proxy,operation==='remove'?'document.querySelector("link").removeAttribute("href")':operation==='empty'?'document.querySelector("link").href=""':'document.querySelector("link").href="http://["');
      if(proxy)await page.evaluate(()=>releaseStyleHref());else releaseNative();
      await until(proxy,'pendingStyleLoads===1');
      values.push({...await read(proxy,snapshot),loads:await evaluate(proxy,'pendingStyleLoads')});
    }
    return values;
  };
  try{
    const expected=await run(false);
    await page.evaluate(({base,html})=>{
      const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=async(url,options)=>{
        if(!String(url).startsWith(base))return previous(url,options);
        const path=new URL(url).pathname;
        if(path.endsWith('slow.css'))await new Promise(resolve=>globalThis.releaseStyleHref=resolve);
        return new Response(path.endsWith('.css')?'#probe{padding-left:'+(path.endsWith('two.css')?29:17)+'px}':html,{headers:{'Content-Type':path.endsWith('.css')?'text/css':'text/html'}});
      };
    },{base,html});
    const actual=await run(true);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Stylesheet attribute parity: '+JSON.stringify({expected,actual}));
    return ['Stylesheet attributes retain authored URLs for existing-resource detection','Stylesheet href removal/empty values and pending requests match native lifecycle behavior','Stylesheet attribute methods preserve borrowed receivers, arity and coercion'];
  }finally{await nativeContext.close();}
}
