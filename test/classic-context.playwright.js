async page=>{
  const {createServer}=process.getBuiltinModule('node:http');let a,b,requests=0;const nativeRows=[];
  const html=()=>`<!doctype html><base href="/assets/"><body>Classic contexts
    <script>window.classicImports=[];document.cookie='classic_ctx=1; SameSite=Lax; Path=/';<\/script>
    <script src="${b}/classic.js" data-id="private" referrerpolicy="no-referrer"><\/script>
    <script src="${b}/classic.js" data-id="origin" crossorigin="use-credentials" referrerpolicy="origin"><\/script>
    <script src="${b}/classic.js" data-id="anonymous" crossorigin="anonymous" referrerpolicy="unsafe-url"><\/script>
    <script src="${b}/response.js" data-id="response" crossorigin="anonymous" referrerpolicy="unsafe-url"><\/script>
    <script src="/back-start.js" referrerpolicy="unsafe-url"><\/script>
    <script referrerpolicy="no-referrer">classicImports.push(()=>import('./inline-private.js'));<\/script>
    <script referrerpolicy="unsafe-url">classicImports.push(()=>import('./inline-full.js'));window.classicReady=true;<\/script>`;
  const resource=(side,path)=>{
    if(side==='a'&&path==='/page/index.html')return {type:'text/html',body:html()};
    if(side==='b'&&['/classic.js','/response.js'].includes(path))return {policy:path==='/response.js'?'no-referrer':undefined,body:'(()=>{const id=document.currentScript.dataset.id;classicImports.push(async()=>{if(id==="private"){try{await import("./blocked-relative.js");window.classicMuted="allowed"}catch(error){window.classicMuted=error.name}}return import('+JSON.stringify(b+'/late-')+'+id+".js")})})();'};
    if(side==='a'&&path==='/workers/entry.js')return {policy:'origin',body:'importScripts('+JSON.stringify(b+'/worker-import.js')+',"./local-import.js");onmessage=async()=>{await localLate();postMessage(await workerLate())};'};
    if(side==='a'&&path==='/workers/local-import.js')return {policy:'no-referrer',body:'self.localLate=()=>import("./local-late.js");'};
    if(side==='b'&&path==='/worker-import.js')return {policy:'no-referrer',body:'importScripts("./nested.js");self.workerLate=async()=>{let muted;try{await import("./blocked-worker.js");muted="allowed"}catch(error){muted=error.name}await import('+JSON.stringify(b+'/worker-late.js')+');return muted};'};
    if(side==='a'&&path==='/workers/nested.js')return {body:'self.nestedReady=true;'};
    if(side==='a'&&path==='/workers/held-entry.js')return {body:'importScripts("./held-import.js");postMessage("late")'};
    if(side==='a'&&path==='/opaque-import.js')return {body:'self.opaqueLate=()=>import('+JSON.stringify(b+'/opaque-late.js')+');'};
    if(side==='b'&&path==='/redirect-worker.js')return {body:'postMessage("redirected")'};
    if(side==='a'&&path==='/back-final.js')return {body:'classicImports.push(async()=>{try{await import("./blocked-back.js");window.backMuted="allowed"}catch(error){window.backMuted=error.name}return import('+JSON.stringify(a+'/back-late.js')+')});'};
    return {body:'export const value=1;'};
  };
  const record=(side,path,headers)=>({side,path,referrer:headers.referer||null,cookie:(headers.cookie||'').split('; ').filter(value=>value.startsWith('classic_ctx=')).join('; '),origin:headers.origin||null});
  const server=side=>createServer((request,response)=>{
    requests++;const path=new URL(request.url,side==='a'?a:b).pathname;nativeRows.push(record(side,path,request.headers));
    if(side==='a'&&path==='/workers/redirect.js'){response.writeHead(302,{Location:b+'/redirect-worker.js','Cache-Control':'no-store'});response.end();return}
    if(side==='a'&&path==='/back-start.js'||side==='b'&&path==='/back-hop.js'){response.writeHead(302,{Location:side==='a'?b+'/back-hop.js':a+'/back-final.js','Cache-Control':'no-store'});response.end();return}
    const value=resource(side,path);
    response.writeHead(200,{'Content-Type':value.type||'text/javascript','Cache-Control':'no-store','Access-Control-Allow-Origin':request.headers.origin||a,'Access-Control-Allow-Credentials':'true',...(value.type==='text/html'?{'Set-Cookie':'classic_ctx=1; SameSite=Lax; Path=/'}:{}),...(value.policy?{'Referrer-Policy':value.policy}:{})});response.end(value.body);
  });
  const first=server('a'),second=server('b');
  await Promise.all([first,second].map(server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})));
  a='http://127.0.0.1:'+first.address().port;b='http://127.0.0.1:'+second.address().port;
  const context=await page.context().browser().newContext(),native=await context.newPage();
  const run=`(async()=>{
    for(let index=0;!window.classicReady;index++){if(index>300)throw new Error('Classic contexts did not initialize');await new Promise(resolve=>setTimeout(resolve,10))}
    const meta=document.createElement('meta');meta.name='referrer';meta.content='no-referrer';document.head.append(meta);history.replaceState(null,'','/changed/index.html');
    await Promise.all(classicImports.map(load=>load()));
    const receive=(worker,start)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Classic worker context timed out')),5000);worker.onmessage=event=>{clearTimeout(timer);resolve(event.data)};worker.onerror=event=>{clearTimeout(timer);event.preventDefault();reject(new Error(event.message))};if(start)worker.postMessage('run')});
    const worker=new Worker('/workers/entry.js');let muted;try{muted=await receive(worker,true)}finally{worker.terminate()}
    const opaqueSource='importScripts('+JSON.stringify(location.origin+'/opaque-import.js')+');onmessage=async()=>{await opaqueLate();postMessage("opaque")};';
    const opaque=new Worker('data:text/javascript,'+encodeURIComponent(opaqueSource));let opaqueResult;try{opaqueResult=await receive(opaque,true)}finally{opaque.terminate()}
    const redirects=[];for(const type of ['classic','module']){const worker=new Worker('/workers/redirect.js',{type});try{redirects.push(await new Promise(resolve=>{const timer=setTimeout(()=>resolve('timeout'),3000);worker.onmessage=()=>{clearTimeout(timer);resolve('loaded')};worker.onerror=event=>{clearTimeout(timer);event.preventDefault();resolve('error')}}))}finally{worker.terminate()}}
    return JSON.stringify({worker:muted,window:window.classicMuted,back:window.backMuted,opaque:opaqueResult,redirects});
  })()`;
  const selected=rows=>rows.filter(row=>row.path!=='/page/index.html'&&!row.path.endsWith('favicon.ico')).sort((x,y)=>JSON.stringify(x).localeCompare(JSON.stringify(y)));
  try{
    await native.goto(a+'/page/index.html');const expectedResult=await native.evaluate(source=>eval(source),run);
    await native.close();const baseline=selected(nativeRows),nativeRequests=requests,relay=[];
    await page.exposeFunction('classicContextRequest',(url,headers)=>{const parsed=new URL(url);relay.push(record(parsed.origin===a?'a':'b',parsed.pathname,headers||{}))});
    const paths={a:['/page/index.html','/assets/inline-private.js','/assets/inline-full.js','/workers/entry.js','/workers/nested.js','/workers/local-import.js','/workers/local-late.js','/opaque-import.js','/workers/held-entry.js','/back-final.js','/back-late.js'],b:['/classic.js','/response.js','/late-private.js','/late-origin.js','/late-anonymous.js','/late-response.js','/worker-import.js','/worker-late.js','/opaque-late.js','/redirect-worker.js']};
    const files=Object.fromEntries(Object.entries(paths).map(([side,paths])=>[side,Object.fromEntries(paths.map(path=>[path,resource(side,path)]))]));
    await page.evaluate(({a,b,files})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(target,options)=>{
      const url=new URL(target),side=url.origin===a?'a':url.origin===b?'b':null;if(!side)return previous(target,options);classicContextRequest(url.href,options.headers);
      if(side==='a'&&url.pathname==='/workers/held-import.js'){globalThis.heldClassicRequested=true;return new Promise(resolve=>{globalThis.releaseClassicImport=()=>resolve(new Response('postMessage("late")',{headers:{'Content-Type':'text/javascript','Cache-Control':'no-store'}}))})}
      if(side==='a'&&url.pathname==='/workers/redirect.js')return Promise.resolve(new Response(null,{status:302,headers:{Location:b+'/redirect-worker.js','Cache-Control':'no-store'}}));
      if(side==='a'&&url.pathname==='/back-start.js'||side==='b'&&url.pathname==='/back-hop.js')return Promise.resolve(new Response(null,{status:302,headers:{Location:side==='a'?b+'/back-hop.js':a+'/back-final.js','Cache-Control':'no-store'}}));
      const value=files[side][url.pathname];return Promise.resolve(new Response(value?.body||'export const value=1;',{headers:{'Content-Type':value?.type||'text/javascript','Cache-Control':'no-store','Access-Control-Allow-Origin':options.headers.origin||a,'Access-Control-Allow-Credentials':'true',...(value?.type==='text/html'?{'Set-Cookie':'classic_ctx=1; SameSite=Lax; Path=/'}:{}),...(value?.policy?{'Referrer-Policy':value.policy}:{})}}));
    };},{a,b,files});
    await page.evaluate(url=>main_frame.navigate_to(url),a+'/page/index.html');
    const actualResult=await page.evaluate(source=>main_frame.eval_js(source),run);
    if(actualResult!==expectedResult)throw new Error('Classic import results differ: '+JSON.stringify({expectedResult,actualResult}));
    const actual=selected(relay);if(JSON.stringify(actual)!==JSON.stringify(baseline))throw new Error('Classic script contexts differ: '+JSON.stringify({expected:baseline,actual}));
    await page.evaluate(()=>main_frame.eval_js('window.classicLateMessages=0;window.heldClassicWorker=new Worker("/workers/held-entry.js");heldClassicWorker.onmessage=()=>classicLateMessages++;void 0;'));
    await page.waitForFunction(()=>globalThis.heldClassicRequested===true);
    const heldId=await page.evaluate(url=>Object.values(sandstone.controller.iframes).find(frame=>frame.worker&&frame.url.href===url)?.id,a+'/workers/held-entry.js');
    if(!heldId)throw new Error('Worker prefetch has no registered context');
    await page.evaluate(()=>main_frame.eval_js('heldClassicWorker.terminate();void 0;'));
    await page.waitForFunction(id=>!sandstone.controller.iframes[id],heldId);
    await page.evaluate(()=>releaseClassicImport());await page.waitForTimeout(100);
    if(await page.evaluate(()=>main_frame.eval_js('classicLateMessages'))!==0)throw new Error('Terminated worker resumed after a held script response');
    if(requests!==nativeRequests)throw new Error('A classic script made a direct HTTP request');
    return ['Classic scripts retain distinct import policies and credentials across repeated URLs and document changes','Classic worker imports retain worker request metadata and imported script module bases','Worker prefetch respects opaque origins, redirect boundaries and cancellation before startup'];
  }finally{
    // Session cookies now survive host reloads, just as they do natively.
    // Remove this fixture's cookie before the next fresh native comparison.
    await page.evaluate(origin=>sandstone.controller.site_data.setCookie(origin+'/','classic_ctx=; Max-Age=0; Path=/'),a).catch(()=>{});
    try{await context.close();}finally{for(const server of [first,second])server.closeAllConnections();await Promise.all([first,second].map(server=>new Promise(resolve=>server.close(resolve))))}
  }
}
