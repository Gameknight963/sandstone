async (page,allowDiagnostics)=>{
  const origin='https://script-ordering.test',context=await page.context().browser().newContext(),native=await context.newPage(),direct=[];
  const html='<!doctype html><body><script>globalThis.orderLog=[];</script>';
  allowDiagnostics?.(['Script failed: /first.js?module=false&tla=false&fail=true: Script request failed: 404','Script failed: /first.js?module=true&tla=false&fail=true: Module request failed (404): '+origin+'/first.js?module=true&tla=false&fail=true']);
  const source=(id,module,tla)=>`orderLog.push(${JSON.stringify(id+':execute:')}+location.origin);`+(tla?'await new Promise(resolve=>globalThis.releaseTLA=resolve);orderLog.push("await-end");':'');
  let releaseNative,requests=[];
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const until=async(proxy,expression)=>{const end=Date.now()+5000;while(!await evaluate(proxy,expression)){if(Date.now()>end)throw new Error('Script order timed out: '+expression+' '+await evaluate(proxy,'JSON.stringify(orderLog)'));await new Promise(resolve=>setTimeout(resolve,10));}};
  const configurations=[
    {name:'classic',first:false,second:false},
    {name:'module',first:true,second:true},
    {name:'default async modules',first:true,second:true,unordered:true},
    {name:'module-classic',first:true,second:false},
    {name:'classic-module',first:false,second:true},
    {name:'top-level await',first:true,second:false,tla:true},
    {name:'failed first',first:false,second:false,fail:true},
    {name:'failed module',first:true,second:true,fail:true},
    {name:'removed first',first:false,second:false,remove:true},
    {name:'later async change',first:false,second:false,toggle:true},
    {name:'default async',first:false,second:false,unordered:true}
  ];
  const block=route=>{direct.push(route.request().url());return route.abort();};
  const run=async(proxy,configuration)=>{
    requests=[];releaseNative=undefined;
    if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');else await native.goto(origin+'/start');
    if(proxy)await page.evaluate(()=>{globalThis.orderRequests=[];delete globalThis.releaseOrderFirst;});
    await evaluate(proxy,`(()=>{for(const [id,module] of [['first',${configuration.first}],['second',${configuration.second}]]){const script=document.createElement('script');script.id=id;if(module)script.type='module';${configuration.unordered?'':'script.async=false;'}script.onload=()=>orderLog.push(id+':load');script.onerror=()=>orderLog.push(id+':error');script.src='/'+id+'.js?module='+module+'&tla='+(${!!configuration.tla}&&id==='first')+'&fail='+(${!!configuration.fail}&&id==='first');document.body.append(script);${configuration.remove?"if(id==='first')script.remove();":''}${configuration.toggle?'script.async=true;':''}}})()`);
    const deadline=Date.now()+5000;
    while(proxy?!await page.evaluate(()=>orderRequests.includes('second')):!requests.includes('second')){if(Date.now()>deadline)throw new Error('Second script did not download: '+JSON.stringify({proxy,configuration,requests:proxy?await page.evaluate(()=>orderRequests):requests,log:await evaluate(proxy,'JSON.stringify(orderLog)')}));await new Promise(resolve=>setTimeout(resolve,10));}
    await new Promise(resolve=>setTimeout(resolve,80));
    const held=await evaluate(proxy,'JSON.stringify(orderLog)');
    if(proxy)await page.evaluate(()=>releaseOrderFirst());else releaseNative();
    await until(proxy,configuration.tla?'typeof releaseTLA==="function"&&orderLog.some(value=>value.startsWith("second:execute"))':'orderLog.filter(value=>/:load$|:error$/.test(value)).length===2');
    const beforeAwait=configuration.tla?await evaluate(proxy,'JSON.stringify(orderLog)'):null;
    if(configuration.tla){await evaluate(proxy,'releaseTLA()');await until(proxy,'orderLog.filter(value=>/:load$|:error$/.test(value)).length===2');}
    return {held,beforeAwait,finished:await evaluate(proxy,'JSON.stringify(orderLog)')};
  };
  try{
    await native.route(origin+'/**',async route=>{const url=new URL(route.request().url()),id=url.pathname.slice(1,-3);if(!url.pathname.endsWith('.js'))return route.fulfill({contentType:'text/html',body:html});requests.push(id);if(id==='first')await new Promise(resolve=>releaseNative=resolve);await route.fulfill({status:url.searchParams.get('fail')==='true'?404:200,contentType:'text/javascript',body:source(id,url.searchParams.get('module')==='true',url.searchParams.get('tla')==='true')});});
    await page.route(/^https?:/,block);
    await page.evaluate(({origin,html,sourceText})=>{const source=eval('('+sourceText+')'),previous=sandstone.network.session.fetch;sandstone.network.session.fetch=async(url,options)=>{if(new URL(url).origin!==origin)return previous(url,options);const target=new URL(url),id=target.pathname.slice(1,-3);if(!target.pathname.endsWith('.js'))return new Response(html,{headers:{'Content-Type':'text/html'}});orderRequests.push(id);if(id==='first')await new Promise(resolve=>globalThis.releaseOrderFirst=resolve);return new Response(source(id,target.searchParams.get('module')==='true',target.searchParams.get('tla')==='true'),{status:target.searchParams.get('fail')==='true'?404:200,headers:{'Content-Type':'text/javascript'}});};},{origin,html,sourceText:source.toString()});
    for(const configuration of configurations){const expected=await run(false,configuration),actual=await run(true,configuration);if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Dynamic script ordering differs for '+configuration.name+': '+JSON.stringify({expected,actual}));}
    if(direct.length)throw new Error('Ordered scripts attempted direct HTTP: '+JSON.stringify(direct));
    return ['Dynamic async=false scripts retain preparation order across classic scripts and modules','Ordered scripts release failures, retain removed elements and preserve top-level await behavior','Default async scripts remain independent and async changes cannot reorder prepared scripts'];
  }finally{releaseNative?.();await context.close();await page.unroute(/^https?:/,block);}
}
