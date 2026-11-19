async (page,{batch=0,batches=1}={})=>{
  const origin='https://script-bodies.test',context=await page.context().browser().newContext(),native=await context.newPage(),direct=[];
  const html='<!doctype html><body><script>globalThis.bodyLog=[];globalThis.bodyEvents=[];</script>';
  const cases=[['empty',`script.textContent='';`],['space','script.textContent='+JSON.stringify(' \t\r\n')+';'],['unicode space','script.textContent='+JSON.stringify('\u00a0\uFEFF')+';'],['comment',`script.textContent='/* comment */';`],['code',`script.textContent=code;`],['comment node',`script.append(document.createComment(code));`],['descendant text',`const child=document.createElement('span');child.textContent=code;script.append(child);`],['mixed children',`const child=document.createElement('span');child.textContent='bodyLog.push("descendant");';script.append(child,document.createTextNode(code));`],['CDATA',`script.append(document.implementation.createDocument(null,'root').createCDATASection(code));`]];
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const run=async(proxy,namespace,module,name,operation)=>{
    if(proxy){await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');await page.evaluate(()=>globalThis.bodyRequests=[]);}else await native.goto(origin+'/start');
    await evaluate(proxy,`(()=>{globalThis.bodyScript=${namespace==='html'?"document.createElement('script')":"document.createElementNS('http://www.w3.org/2000/svg','script')"};const script=bodyScript,code='bodyLog.push("inline:"+location.origin);';${module?"script.setAttribute('type','module');":''}script.onload=()=>bodyEvents.push('load');script.onerror=()=>bodyEvents.push('error');${operation}document.body.append(script);bodyLog.push('after');})()`);
    if(module&&['code','mixed children','CDATA'].includes(name)){
      const deadline=Date.now()+5000;
      while(!await evaluate(proxy,'bodyLog.some(value=>value.startsWith("inline:"))')){if(Date.now()>deadline)throw new Error('Inline module body did not execute: '+namespace+' '+name);await new Promise(resolve=>setTimeout(resolve,10));}
    }
    await new Promise(resolve=>setTimeout(resolve,80));
    const before=await evaluate(proxy,'JSON.stringify({log:bodyLog,events:bodyEvents})');
    await evaluate(proxy,`bodyScript.${namespace==='html'?'src':'href.baseVal'}='/after.js';bodyScript.append('bodyLog.push("new text");');undefined;`);
    await new Promise(resolve=>setTimeout(resolve,80));
    return {before,after:await evaluate(proxy,'JSON.stringify({log:bodyLog,events:bodyEvents})'),requests:proxy?await page.evaluate(()=>bodyRequests.length):await native.evaluate(()=>performance.getEntriesByType('resource').filter(entry=>entry.name.endsWith('/after.js')).length)};
  };
  const block=route=>{direct.push(route.request().url());return route.abort();};
  try{
    await native.route(origin+'/**',route=>route.fulfill({contentType:route.request().url().endsWith('.js')?'text/javascript':'text/html',body:route.request().url().endsWith('.js')?'bodyLog.push("external:"+location.origin);':html}));
    await page.route(/^https?:/,block);
    await page.evaluate(({origin,html})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(url,options)=>{if(new URL(url).origin!==origin)return previous(url,options);const script=String(url).endsWith('.js');if(script)bodyRequests.push(url);return Promise.resolve(new Response(script?'bodyLog.push("external:"+location.origin);':html,{headers:{'Content-Type':script?'text/javascript':'text/html'}}));};},{origin,html});
    const differences=[],passed=[];let index=0;
    for(const namespace of ['html','svg'])for(const module of [false,true])for(const [name,operation] of cases){
      if(index++%batches!==batch)continue;
      const expected=await run(false,namespace,module,name,operation),actual=await run(true,namespace,module,name,operation);
      if(JSON.stringify(actual)!==JSON.stringify(expected))differences.push({namespace,module,name,expected,actual});
      passed.push(namespace+' '+(module?'module':'classic')+' script body: '+name);
    }
    if(differences.length)throw new Error('Script body semantics differ: '+JSON.stringify(differences));
    if(direct.length)throw new Error('Script bodies attempted direct HTTP: '+JSON.stringify(direct));
    return passed;
  }finally{await context.close();await page.unroute(/^https?:/,block);}
}
