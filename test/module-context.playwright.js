async page=>{
  const {createServer}=process.getBuiltinModule('node:http');let origin,requests=0;
  const nativeHeaders=[];
  const resources={
    '/modules/root.js':{policy:'no-referrer',body:'import {lazy} from "./child.js";import data from "./data.json" with {type:"json"};window.moduleRoot=()=>import("./late-root.js");window.moduleChild=lazy;window.moduleReady=data.ready;'},
    '/modules/child.js':{policy:'origin',body:'import "./grand.js";export const lazy=()=>import("./late-child.js");'},
    '/modules/data.json':{type:'application/json',body:'{"ready":true}'},
    '/bare/root.js':{body:'import "./child.js";window.bareReady=true;'},
    '/worker/entry.js':{policy:'origin',body:'import {run} from "./child.js";onmessage=async()=>{await import("./late-entry.js");await run();await fetch("./fetch");postMessage("done")};'},
    '/worker/child.js':{policy:'no-referrer',body:'export const run=()=>import("./late-child.js");'}
  };
  for(const type of ['classic','module'])for(const policy of ['missing','invalid'])resources['/worker-'+policy+'/'+type+'.js']={...(policy==='invalid'?{policy:'invalid-policy'}:{}),body:'onmessage=async()=>{await fetch('+JSON.stringify('./fetch-'+type)+');postMessage("done")};'};
  const html='<!doctype html><base href="/assets/"><body>Module request contexts'+
    '<script type="module" referrerpolicy="origin" src="/redirect.js"><\/script>'+
    '<script type="module" referrerpolicy="no-referrer" src="/bare/root.js"><\/script>'+
    '<script type="module" referrerpolicy="no-referrer">import "./inline-a.js";window.inlinePrivate=()=>import("./late-a.js");window.aReady=true;<\/script>'+
    '<script type="module" referrerpolicy="unsafe-url">import "./inline-b.js";window.inlineFull=()=>import("./late-b.js");window.bReady=true;<\/script>';
  const resource=path=>path==='/page/index.html'?{type:'text/html',body:html}:resources[path]||{type:'text/javascript',body:'export const value=1;'};
  const server=createServer((request,response)=>{
    requests++;const path=new URL(request.url,origin).pathname;nativeHeaders.push({path,referrer:request.headers.referer||null});
    if(path==='/redirect.js'){response.writeHead(302,{Location:'/modules/root.js'});response.end();return}
    const value=resource(path);response.writeHead(200,{'Content-Type':value.type||'text/javascript',...(value.policy?{'Referrer-Policy':value.policy}:{})});response.end(value.body);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});origin='http://127.0.0.1:'+server.address().port;
  const context=await page.context().browser().newContext(),native=await context.newPage();
  const run=`(async()=>{
    for(let index=0;!window.moduleReady||!window.aReady||!window.bReady||!window.bareReady;index++){if(index>300)throw new Error('Module contexts did not initialize');await new Promise(resolve=>setTimeout(resolve,10))}
    const meta=document.createElement('meta');meta.name='referrer';meta.content='no-referrer';document.head.append(meta);history.replaceState(null,'','/moved/index.html');
    await Promise.all([window.moduleRoot(),window.moduleChild(),window.inlinePrivate(),window.inlineFull()]);
    const cases=[['/worker/entry.js','module'],...['classic','module'].flatMap(type=>['missing','invalid'].map(policy=>['/worker-'+policy+'/'+type+'.js',type]))];
    for(const [url,type] of cases){const worker=new Worker(url,{type});try{if(await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Worker context timed out: '+url)),5000);worker.onmessage=event=>{clearTimeout(timer);resolve(event.data)};worker.onerror=event=>{clearTimeout(timer);event.preventDefault();reject(new Error(event.message))};worker.postMessage('run')})!=='done')throw new Error('Worker context failed: '+url)}finally{worker.terminate()}}
    return 'done';
  })()`;
  const selected=rows=>rows.filter(row=>row.path!=='/page/index.html'&&!row.path.endsWith('favicon.ico')).sort((a,b)=>a.path.localeCompare(b.path));
  try{
    await native.goto(origin+'/page/index.html');if(await native.evaluate(source=>eval(source),run)!=='done')throw new Error('Native module context worker failed');
    await native.close();const baseline=selected(nativeHeaders),nativeRequests=requests,relay=[];
    await page.exposeFunction('moduleContextRequest',(url,headers)=>relay.push({path:new URL(url).pathname,referrer:headers?.referer||null}));
    const files=Object.fromEntries(['/page/index.html',...baseline.map(row=>row.path)].map(path=>[path,resource(path)]));
    await page.evaluate(({origin,files})=>{
      const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(target,options)=>{
        const url=new URL(target);if(url.origin!==origin)return previous(target,options);moduleContextRequest(url.href,options.headers);
        if(url.pathname==='/redirect.js')return Promise.resolve(new Response(null,{status:302,headers:{Location:'/modules/root.js'}}));
        const value=files[url.pathname];return Promise.resolve(new Response(value?.body||'export const value=1;',{headers:{'Content-Type':value?.type||'text/javascript',...(value?.policy?{'Referrer-Policy':value.policy}:{})}}));
      };
    },{origin,files});
    await page.evaluate(url=>main_frame.navigate_to(url),origin+'/page/index.html');
    if(await page.evaluate(source=>main_frame.eval_js(source),run)!=='done')throw new Error('Proxied module context worker failed');
    const actual=selected(relay);if(JSON.stringify(actual)!==JSON.stringify(baseline))throw new Error('Module request contexts differ: '+JSON.stringify({expected:baseline,actual}));
    if(requests!==nativeRequests)throw new Error('A module dependency made a direct HTTP request');
    return ['Module dependencies retain parent URLs and response referrer policies across redirects and delayed imports','Inline modules keep distinct attribute policies and module workers retain response policy contexts'];
  }finally{try{await context.close();}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}}
}
