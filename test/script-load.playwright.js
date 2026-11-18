async (page,allowDiagnostics)=>{
  const origin='https://script-load.test',context=await page.context().browser().newContext(),native=await context.newPage(),direct=[];
  const cases=[{name:'classic'},{name:'ordered',ordered:true},{name:'module',module:true},{name:'ordered-module',module:true,ordered:true},{name:'child',child:true},{name:'error-recovery',fail:true,child:true},{name:'removed',removed:true},{name:'dom-content-loaded',dom:true},{name:'dom-microtask',microtask:true},{name:'after-load',late:true},{name:'top-level-await',module:true,tla:true}];
  allowDiagnostics?.(['Script failed: /first.js?case=error-recovery: Script request failed: 404']);
  const setup=configuration=>`globalThis.loadLog=[];globalThis.loadMark=name=>loadLog.push(name+':'+document.readyState);document.addEventListener('DOMContentLoaded',()=>loadMark('dom'));addEventListener('load',()=>loadMark('window'));const insert=()=>{const script=document.createElement('script');${configuration.module?"script.type='module';":''}${configuration.ordered?'script.async=false;':''}script.src='/first.js?case=${configuration.name}';script.onload=()=>loadMark('first-load');script.onerror=()=>{loadMark('first-error');${configuration.child?'insertChild();':''}};document.head.append(script);${configuration.removed?'script.remove();':''}};globalThis.insertChild=()=>{const child=document.createElement('script');child.src='/child.js?case=${configuration.name}';child.onload=()=>loadMark('child-load');document.head.append(child);};${configuration.dom?"document.addEventListener('DOMContentLoaded',insert);":configuration.microtask?"document.addEventListener('DOMContentLoaded',()=>queueMicrotask(insert));":configuration.late?"addEventListener('load',insert);":'insert();'}`;
  const html=configuration=>'<!doctype html><head><script>'+setup(configuration)+'</script></head><body><script>loadMark("tail");</script>';
  const code=(id,configuration)=>`loadMark(${JSON.stringify(id+'-execute')});`+(id==='first'&&configuration.child&&!configuration.fail?'insertChild();':'')+(configuration.tla?'await new Promise(resolve=>globalThis.releaseLoadAwait=resolve);loadMark("await-end");':'');
  const pages=Object.fromEntries(cases.map(configuration=>[configuration.name,{html:html(configuration),first:code('first',configuration),child:code('child',{}),fail:!!configuration.fail}]));
  pages.replacement={html:'<!doctype html><body><script>globalThis.loadReplacement=true;</script>Replacement'};
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const until=async(predicate,label)=>{const end=Date.now()+5000;while(!await predicate()){if(Date.now()>end)throw new Error('Script load timed out: '+label);await new Promise(resolve=>setTimeout(resolve,10));}};
  let first,child;
  const run=async(proxy,configuration)=>{
    first=child=undefined;
    if(proxy)await page.evaluate(()=>{delete globalThis.releaseLoadFirst;delete globalThis.releaseLoadChild;});
    const navigation=proxy?page.evaluate(url=>main_frame.navigate_to(url),origin+'/'+configuration.name):native.goto(origin+'/'+configuration.name,{waitUntil:'domcontentloaded'});
    navigation.catch(()=>{});
    await until(()=>proxy?page.evaluate(()=>typeof releaseLoadFirst==='function'):!!first,'first request '+configuration.name);
    await until(()=>evaluate(proxy,'globalThis.loadLog?.some(value=>value.startsWith("dom:"))'),'DOMContentLoaded '+configuration.name);
    await new Promise(resolve=>setTimeout(resolve,30));
    const held=await evaluate(proxy,'JSON.stringify(loadLog)');
    if(proxy)await page.evaluate(()=>releaseLoadFirst());else first();
    let nested=null;
    if(configuration.child){
      await until(()=>proxy?page.evaluate(()=>typeof releaseLoadChild==='function'):!!child,'child request '+configuration.name);
      await new Promise(resolve=>setTimeout(resolve,30));nested=await evaluate(proxy,'JSON.stringify(loadLog)');
      if(proxy)await page.evaluate(()=>releaseLoadChild());else child();
    }
    if(configuration.tla){
      await until(()=>evaluate(proxy,'typeof releaseLoadAwait==="function"'),'top-level await');
      await new Promise(resolve=>setTimeout(resolve,30));nested=await evaluate(proxy,'JSON.stringify(loadLog)');
      await evaluate(proxy,'releaseLoadAwait()');
    }
    await until(()=>evaluate(proxy,'loadLog.some(value=>value.startsWith("first-load:"))||loadLog.some(value=>value.startsWith("first-error:"))'),'script event');
    await until(()=>evaluate(proxy,'loadLog.some(value=>value.startsWith("window:"))'),'window load');
    await navigation;
    return {held,nested,finished:await evaluate(proxy,'JSON.stringify(loadLog)')};
  };
  const block=route=>{direct.push(route.request().url());return route.abort();};
  try{
    await native.route(origin+'/**',async route=>{const url=new URL(route.request().url()),id=url.pathname.slice(1,-3),configuration=pages[url.searchParams.get('case')];if(!configuration){const item=pages[url.pathname.slice(1)];return route.fulfill({status:item?200:404,contentType:'text/html',body:item?.html||''});}await new Promise(resolve=>{if(id==='first')first=resolve;else child=resolve;});await route.fulfill({status:configuration.fail&&id==='first'?404:200,contentType:'text/javascript',body:configuration[id]});});
    await page.route(/^https?:/,block);
    await page.evaluate(({origin,pages})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=async(url,options)=>{const target=new URL(url);if(target.origin!==origin)return previous(url,options);const id=target.pathname.slice(1,-3),configuration=pages[target.searchParams.get('case')];if(!configuration){const item=pages[target.pathname.slice(1)];return new Response(item?.html||'',{status:item?200:404,headers:{'Content-Type':'text/html'}});}await new Promise(resolve=>{if(id==='first')globalThis.releaseLoadFirst=resolve;else globalThis.releaseLoadChild=resolve;});return new Response(configuration[id],{status:configuration.fail&&id==='first'?404:200,headers:{'Content-Type':'text/javascript'}});};},{origin,pages});
    const mismatches=[];
    for(const configuration of cases){const expected=await run(false,configuration),actual=await run(true,configuration);if(JSON.stringify(actual)!==JSON.stringify(expected))mismatches.push({case:configuration.name,expected,actual});}
    if(mismatches.length)throw new Error('Dynamic script load timing differs: '+JSON.stringify(mismatches));
    await page.evaluate(()=>delete globalThis.releaseLoadFirst);
    let retiredSettled=false;
    const retired=page.evaluate(url=>main_frame.navigate_to(url),origin+'/classic').finally(()=>retiredSettled=true);retired.catch(()=>{});
    await until(()=>page.evaluate(()=>typeof releaseLoadFirst==='function'),'retiring script request');
    const replacement=page.evaluate(url=>main_frame.navigate_to(url),origin+'/replacement');replacement.catch(()=>{});
    await until(()=>page.evaluate(()=>!main_frame.is_navigating),'replacement navigation');
    await until(()=>retiredSettled,'retired navigation cancellation');await replacement;
    await page.evaluate(()=>releaseLoadFirst());await retired.catch(()=>{});
    if(!await evaluate(true,'globalThis.loadReplacement&&document.readyState==="complete"'))throw new Error('Retired script load replaced the new document');
    if(direct.length)throw new Error('Script load timing attempted direct HTTP: '+JSON.stringify(direct));
    return ['Dynamic classic/module scripts delay window.load without delaying DOMContentLoaded','Chained scripts and error recovery extend the document load lifetime','Removed scripts, late insertion and top-level await retain native document timing','Superseding navigation cancels a dynamic script load wait without blocking the new document'];
  }finally{first?.();child?.();await context.close();await page.unroute(/^https?:/,block);}
}
