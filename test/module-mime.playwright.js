async page=>{
  const origin='https://module-mime.test';
  const cases=[
    ...['text/javascript','application/javascript','application/ecmascript','text/ecmascript','application/x-javascript','application/x-ecmascript','text/javascript1.0','text/javascript1.1','text/javascript1.2','text/javascript1.3','text/javascript1.4','text/javascript1.5','text/jscript','text/livescript','text/x-javascript','text/x-ecmascript','TEXT/JAVASCRIPT; charset=windows-1252','text/javascript; note="a,b"','text/plain, text/javascript','text/javascript, garbage','text/javascript, */*','text/javascript;note="unfinished\\'].map(mime=>({mime,type:'javascript'})),
    ...['text/plain','text/html','application/json',null,'text/javascript, text/plain','text/ javascript','text/javascript\u00a0'].map(mime=>({mime,type:'javascript'})),
    ...['application/json','text/json','application/manifest+json','application/vnd.site+json; charset=utf-8','TEXT/JSON','text/plain, application/json'].map(mime=>({mime,type:'json'})),
    ...['text/plain','text/javascript','application/jsonp',null,'application/json, text/html'].map(mime=>({mime,type:'json'})),
    ...['text/css','TEXT/CSS; charset=utf-8','text/plain, text/css','text/css, broken','text/plain',null,'text/css\u00a0','text/css, text/plain'].map(mime=>({mime,type:'css'}))
  ];
  const responses=Object.fromEntries(cases.map(({mime,type},index)=>['/case-'+index,{mime,body:type==='json'?'{"value":42}':type==='css'?'body{color:red}':'globalThis.mimeExecutions++;export const value=42;'}]));
  Object.assign(responses,{
    '/fallback.js':{mime:'text/javascript',body:'export const value=17;'},
    '/bad-dependency.js':{mime:'text/javascript',body:'import "/bad.js";globalThis.mimeExecutions++;export const value=99;'},
    '/bad.js':{mime:'text/html',body:'globalThis.mimeExecutions++;export const value=99;'},
    '/worker-good.js':{mime:'text/javascript',body:'postMessage(42);'},
    '/worker-bad.js':{mime:'text/plain',body:'postMessage(99);'}
  });
  const html='<!doctype html><body>Module MIME fixture';
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route(origin+'/**',route=>{const response=responses[new URL(route.request().url()).pathname];return route.fulfill({headers:response?.mime?{'Content-Type':response.mime}:{},body:Buffer.from(response?.body||html)});});
  await page.evaluate(({origin,responses,html})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(url,options)=>{
    if(new URL(url).origin!==origin)return previous(url,options);
    const response=responses[new URL(url).pathname];return Promise.resolve(new Response(new TextEncoder().encode(response?.body||html),{headers:response?.mime?{'Content-Type':response.mime}:{}}));
  };},{origin,responses,html});
  const source=`(async()=>{
    globalThis.mimeExecutions=0;const results=[];
    for(const [index,item] of ${JSON.stringify(cases)}.entries()){
      try{const module=await import('/case-'+index,item.type==='javascript'?{}:{with:{type:item.type}});results.push(['ok',item.type==='json'?module.default.value:item.type==='css'?module.default.cssRules[0].style.color:module.value]);}
      catch(error){results.push(['error',error.name]);}
    }
    let dependency;try{await import('/bad-dependency.js');dependency='executed';}catch(error){dependency=[error.name,(await import('/fallback.js')).value];}
    const workers=[];for(const name of ['good','bad'])workers.push(await new Promise(resolve=>{const worker=new Worker('/worker-'+name+'.js',{type:'module'});worker.onmessage=event=>{worker.terminate();resolve(['message',event.data])};worker.onerror=event=>{event.preventDefault();worker.terminate();resolve(['error'])};}));
    return {results,dependency,workers,executions:mimeExecutions};
  })()`;
  try{
    await native.goto(origin+'/page');const expected=await native.evaluate(source=>eval(source),source);
    await page.evaluate(url=>main_frame.navigate_to(url),origin+'/page');const actual=await page.evaluate(source=>main_frame.eval_js(source),source);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Module MIME behavior differs: '+JSON.stringify({actual,expected}));
    return ['JavaScript, JSON and CSS module response types match native MIME handling, including parameters and repeated headers','Invalid module dependencies and worker entries fail without execution and permit fallback imports'];
  }finally{await context.close()}
}
