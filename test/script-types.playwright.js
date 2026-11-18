async page=>{
  const origin='https://script-types.test',nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage(),direct=[],nativeRequests=[];
  const types=['application/ecmascript','application/javascript','application/x-ecmascript','application/x-javascript','text/ecmascript','text/javascript',...Array.from({length:6},(_,index)=>'text/javascript1.'+index),'text/jscript','text/livescript','text/x-ecmascript','text/x-javascript'];
  const variants=[{name:'missing'},...types.map(type=>({name:type,type})),...['',' \ttext/JAVASCRIPT\r\n',' \t','\u00a0text/javascript\u00a0','\uFEFFtext/javascript','\vtext/javascript','text/javascript; charset=utf-8','application/json','MODULE',' module '].map((type,index)=>({name:'special-'+index,type})),
    ...['','JavaScript','JavaScript1.5','JScript','LiveScript','ECMAScript','vbscript',' JavaScript '].map((language,index)=>({name:'language-'+index,language})),{name:'type-precedence',type:'',language:'vbscript'},{name:'invalid-type-precedence',type:' ',language:'JavaScript'}];
  const escaped=value=>value.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
  const element=(namespace,variant,external=false)=>{
    const id=(namespace==='svg'?'svg-':'html-')+(external?'external-':'inline-')+variant.name;
    const attributes=Object.entries(variant).filter(([key])=>key!=='name').map(([key,value])=>' '+key+'="'+escaped(value)+'"').join('');
    const resource=external?' '+(namespace==='svg'?'href':'src')+'="/code.js?id='+encodeURIComponent(id)+'"':'';
    return '<script id="'+escaped(id)+'"'+attributes+resource+'>'+(external?'':'typeLog.push('+JSON.stringify(id)+');')+'</script>';
  };
  const html='<!doctype html><body><script>globalThis.typeLog=[];</script>'+variants.map(variant=>element('html',variant)).join('')+'<svg>'+variants.map(variant=>element('svg',variant)).join('')+'</svg>'+variants.map(variant=>element('html',variant,true)).join('')+'<svg>'+variants.map(variant=>element('svg',variant,true)).join('')+'</svg>';
  const code=url=>'typeLog.push('+JSON.stringify(new URL(url).searchParams.get('id'))+');';
  const block=route=>{direct.push(route.request().url());return route.abort();};
  try{
    await native.route(origin+'/**',route=>{const url=route.request().url(),script=new URL(url).pathname==='/code.js';if(script)nativeRequests.push(new URL(url).searchParams.get('id'));return route.fulfill({contentType:script?'text/javascript':'text/html',body:script?code(url):html});});
    await page.route(/^https?:/,block);
    await page.evaluate(({origin,html})=>{const previous=sandstone.network.session.fetch;globalThis.scriptTypeRequests=[];sandstone.network.session.fetch=(url,options)=>{
      if(new URL(url).origin!==origin)return previous(url,options);
      const target=new URL(url),script=target.pathname==='/code.js';if(script)scriptTypeRequests.push(target.searchParams.get('id'));
      return Promise.resolve(new Response(script?'typeLog.push('+JSON.stringify(target.searchParams.get('id'))+');':html,{headers:{'Content-Type':script?'text/javascript':'text/html'}}));
    };},{origin,html});
    await native.goto(origin+'/start');await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');
    const expected=await native.evaluate(()=>typeLog),actual=JSON.parse(await page.evaluate(()=>main_frame.eval_js('JSON.stringify(typeLog)')));
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Parsed script types differ: '+JSON.stringify({missing:expected.filter(id=>!actual.includes(id)),unexpected:actual.filter(id=>!expected.includes(id)),actual,expected}));
    const requests=await page.evaluate(()=>scriptTypeRequests);
    // Chromium's preload scanner also fetches inert SVG sources and can fetch
    // modules twice. Require executable resources without copying speculation.
    const required=[...new Set(expected.filter(id=>id.includes('-external-')))].sort();
    if(JSON.stringify([...new Set(requests)].sort())!==JSON.stringify(required)||required.some(id=>!nativeRequests.includes(id)))throw new Error('Script type request eligibility differs: '+JSON.stringify({requests,required,nativeRequests}));
    const dynamic=variants.filter(variant=>!variant.type?.toLowerCase().includes('module'));
    const source=`JSON.stringify((()=>{globalThis.typeLog=[];for(const namespace of ['html','svg'])for(const variant of ${JSON.stringify(dynamic)}){const script=namespace==='html'?document.createElement('script'):document.createElementNS('http://www.w3.org/2000/svg','script');for(const key of ['type','language'])if(key in variant)script.setAttribute(key,variant[key]);script.textContent='typeLog.push('+JSON.stringify(namespace+':'+variant.name)+');';document.body.append(script);}return typeLog;})())`;
    const expectedDynamic=await native.evaluate(source=>eval(source),source),actualDynamic=await page.evaluate(source=>main_frame.eval_js(source),source);
    if(actualDynamic!==expectedDynamic)throw new Error('Dynamic script types differ: '+actualDynamic+' expected '+expectedDynamic);
    const clone=`JSON.stringify((()=>{globalThis.typeLog=[];for(const id of ['html-inline-special-7','html-inline-language-6','svg-inline-special-7']){const copy=document.getElementById(id).cloneNode(true);copy.type='application/x-javascript';copy.removeAttribute('src');copy.removeAttribute('href');document.body.append(copy);}return typeLog;})())`;
    const expectedClone=await native.evaluate(source=>eval(source),clone),actualClone=await page.evaluate(source=>main_frame.eval_js(source),clone);
    if(actualClone!==expectedClone)throw new Error('Script type upgrades through cloning differ: '+actualClone+' expected '+expectedClone);
    if(direct.length)throw new Error('Script type handling attempted direct HTTP: '+JSON.stringify(direct));
    return ['HTML/SVG legacy JavaScript MIME types execute through the relay','HTML language fallback, type precedence and ASCII whitespace match native parsing','Dynamic legacy scripts and data-script clones retain native eligibility'];
  }finally{await nativeContext.close();await page.unroute(/^https?:/,block);}
}
