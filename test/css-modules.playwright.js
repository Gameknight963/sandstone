async page=>{
  const {createServer}=process.getBuiltinModule('node:http');let origin,requests=0;
  const calls=[],nativeHeaders=[];
  const sources={
    '/page/export.js':{type:'text/javascript',body:'export {default} from "/redirect.css" with {type:"css"};'},
    '/assets/theme.css':{type:'text/css',headers:{'Referrer-Policy':'no-referrer'},body:'@import "/ignored.css";.probe{color:rgb(17,34,51);background-image:url("./image.svg");filter:url("#missing-filter")}'},
    '/bad.css':{type:'text/javascript',body:'export default "wrong MIME";'},
    '/protected.css':{type:'text/css',body:'.protected {color:rgb(1,2,3)}'},
    '/worker-only.css':{type:'text/css',body:'body{color:red}'},
    '/assets/image.svg':{type:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'},
    '/assets/later.svg':{type:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'}
  };
  const script=`import sheet from '/redirect.css' with {type:'css'};import alias from './export.js';
    window.importedSheet=sheet;window.importedAlias=alias;document.adoptedStyleSheets=[sheet];
    const host=document.querySelector('#host'),shadow=host.attachShadow({mode:'open'});shadow.innerHTML='<div class="probe">Shadow CSS module</div>';shadow.adoptedStyleSheets=[sheet];
    window.moduleReady=true;`;
  const html='<!doctype html><div class="probe">CSS module</div><div id="host"></div><script type="module">'+script+'<\/script>';
  sources['/page/index.html']={type:'text/html',body:html};
  const server=createServer((request,response)=>{requests++;const path=new URL(request.url,origin).pathname;calls.push(path);if(path.endsWith('.svg'))nativeHeaders.push({path,referrer:request.headers.referer||null});if(path==='/redirect.css'){response.writeHead(302,{Location:'/assets/theme.css'});response.end();return}const resource=sources[path];response.writeHead(resource?200:404,{'Content-Type':resource?.type||'text/plain',...resource?.headers});response.end(resource?.body||'missing')});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  origin='http://127.0.0.1:'+server.address().port;
  const context=await page.context().browser().newContext(),native=await context.newPage();
  const read=`(async()=>{
    const until=async test=>{for(let index=0;index<300;index++){if(test())return;await new Promise(resolve=>setTimeout(resolve,10))}throw new Error('CSS module resource timed out')};
    await until(()=>window.moduleReady);
    const sheet=window.importedSheet,dynamic=await import('/redirect.css',{with:{type:'css'}});
    const image=element=>{const value=getComputedStyle(element).backgroundImage;return value.includes('image.svg')||value.includes('blob:')};
    await until(()=>image(document.querySelector('.probe')));
    const result={instance:sheet instanceof CSSStyleSheet,href:sheet.href,owner:sheet.ownerNode,shared:sheet===window.importedAlias&&sheet===dynamic.default,keys:Object.keys(dynamic),rules:sheet.cssRules.length,color:getComputedStyle(document.querySelector('.probe')).color,shadow:getComputedStyle(document.querySelector('#host').shadowRoot.querySelector('.probe')).color};
    const policy=document.createElement('meta');policy.name='referrer';policy.content='no-referrer';document.head.append(policy);
    history.replaceState(null,'','/moved/index.html');
    document.querySelector('.probe').classList.add('later');sheet.insertRule('.later {background-image:url("./later.svg")}',sheet.cssRules.length);
    try{await until(()=>getComputedStyle(document.querySelector('.later')).backgroundImage.includes('later.svg')||getComputedStyle(document.querySelector('.later')).backgroundImage.includes('blob:'))}catch(error){throw new Error(error.message+': '+JSON.stringify({image:getComputedStyle(document.querySelector('.later')).backgroundImage,rules:[...sheet.cssRules].map(rule=>rule.cssText)}))}
    result.after=sheet.cssRules.length;
    const replace=CSSStyleSheet.prototype.replaceSync;
    CSSStyleSheet.prototype.replaceSync=()=>{throw new Error('Authored replacement must not create CSS modules')};
    try{const protectedModule=await import('/protected.css',{with:{type:'css'}});result.protected=protectedModule.default.cssRules[0].style.color}finally{CSSStyleSheet.prototype.replaceSync=replace}
    try{await import('/bad.css',{with:{type:'css'}})}catch(error){result.mime=error.name}
    const worker=new Worker('data:text/javascript,'+encodeURIComponent('import('+JSON.stringify(location.origin+'/worker-only.css')+', {with:{type:"css"}}).then(()=>postMessage("allowed")).catch(error=>postMessage(error.name))'));
    try{result.worker=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('CSS worker import timed out')),3000);worker.onmessage=event=>{clearTimeout(timer);resolve(event.data)};worker.onerror=event=>{clearTimeout(timer);event.preventDefault();reject(new Error(event.message))}})}finally{worker.terminate()}
    return JSON.stringify(result);
  })()`;
  try{
    await native.goto(origin+'/page/index.html');const expected=JSON.parse(await native.evaluate(source=>eval(source),read));
    if(calls.includes('/ignored.css')||calls.includes('/worker-only.css'))throw new Error('Native CSS module fetched an ignored import');
    await native.waitForTimeout(50);if(!calls.includes('/assets/image.svg')||!calls.includes('/assets/later.svg'))throw new Error('Native CSS module resources used the wrong base: '+JSON.stringify(calls));
    await native.close();const nativeRequests=requests;
    const relay=[],relayHeaders=[];
    await page.exposeFunction('cssModuleRequest',(url,headers)=>{relay.push(url);if(url.endsWith('.svg'))relayHeaders.push({path:new URL(url).pathname,referrer:headers?.referer||null})});
    await page.evaluate(({origin,sources})=>{
      const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=(target,options)=>{
        const url=new URL(target);if(url.origin!==origin)return previous(target,options);
        cssModuleRequest(url.href,options?.headers);if(url.pathname==='/redirect.css')return Promise.resolve(new Response(null,{status:302,headers:{Location:'/assets/theme.css'}}));
        const resource=sources[url.pathname];return Promise.resolve(new Response(resource?.body||'missing',{status:resource?200:404,headers:{'Content-Type':resource?.type||'text/plain',...resource?.headers}}));
      };
    },{origin,sources});
    await page.evaluate(url=>main_frame.navigate_to(url),origin+'/page/index.html');
    let actual;try{actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),read))}catch(error){throw new Error(error.message+' relay='+JSON.stringify(relay))}
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('CSS module parity: '+JSON.stringify({expected,actual}));
    for(const path of ['/assets/image.svg','/assets/later.svg'])if(!relay.includes(origin+path))throw new Error('CSS module resource missed its stylesheet base: '+path);
    if(JSON.stringify(relayHeaders)!==JSON.stringify(nativeHeaders))throw new Error('CSS module resource referrers differ: '+JSON.stringify({expected:nativeHeaders,actual:relayHeaders}));
    if(relay.some(url=>url.endsWith('/ignored.css')||url.endsWith('/worker-only.css')))throw new Error('CSS module fetched an ignored import');
    if(requests!==nativeRequests)throw new Error('A CSS module made a direct HTTP request');
    return ['CSS modules support static imports, re-exports, dynamic imports and shared native stylesheet adoption','CSS module redirects and CSSOM edits retain relayed resource bases, MIME validation and worker restrictions'];
  }finally{try{await context.close();}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}}
}
