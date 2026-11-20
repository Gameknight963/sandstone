import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';

const worker=`onmessage=event=>{
  self.steps=[];const errors=[];
  for(const path of event.data){try{importScripts(new URL(path,location.href).href)}catch(error){errors.push([path,error.name])}}
  postMessage({steps,errors});
};`;
const script=(path,version)=>{
  if(path==='/first.js')return 'steps.push("first");importScripts(new URL("/nested.js",location.href).href);';
  if(path==='/nested.js')return '/*'+'padding'.repeat(20000)+'*/steps.push("nested:€");';
  if(path==='/change.js')return 'steps.push("version:'+version+'");';
  if(path==='/delivered.js')return 'steps.push("requested:"+new Error().stack.includes("/redirect.js"));';
  if(path==='/wrong.js')return 'steps.push("wrong MIME executed");';
  return 'steps.push("after");';
};
const paths=['/first.js','/change.js','/change.js','/redirect.js','/wrong.js','/missing.js','/after.js'];
const run=(page,proxy)=>{
  const source=`(async()=>{const worker=new Worker('/worker.js');try{return JSON.stringify(await new Promise((resolve,reject)=>{worker.onmessage=event=>resolve(event.data);worker.onerror=event=>reject(new Error(event.message));worker.postMessage(${JSON.stringify(paths)})}));}finally{worker.terminate();}})()`;
  return proxy?page.evaluate(source=>main_frame.eval_js(source),source):page.evaluate(source=>eval(source),source);
};

export async function verifyWorkerRuntimeImports(page){
  const html=await readFile(new URL('../example/bundled.html',import.meta.url),'utf8');let version=0;
  const server=createServer((request,response)=>{
    response.setHeader('cross-origin-opener-policy','same-origin');response.setHeader('cross-origin-embedder-policy','require-corp');
    const path=new URL(request.url,'http://local').pathname;
    if(path==='/host'){response.setHeader('content-type','text/html');response.end(html);return;}
    if(path==='/redirect.js'){response.writeHead(302,{location:'/delivered.js'});response.end();return;}
    if(path==='/missing.js'){response.writeHead(404,{'content-type':'text/javascript'});response.end('steps.push("404 executed")');return;}
    if(path.endsWith('.js')){response.writeHead(200,{'content-type':path==='/wrong.js'?'text/plain':'text/javascript','cache-control':'no-store'});response.end(path==='/worker.js'?worker:script(path,path==='/change.js'?++version:0));return;}
    response.setHeader('content-type','text/html');response.end('<body>Runtime imports');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  const native=await page.context().newPage(),fixture=await page.context().newPage(),fallback=await page.context().newPage(),direct=[];
  try{
    await native.goto(origin+'/page');const expected=JSON.parse(await run(native,false));
    assert.deepEqual(expected,{steps:['first','nested:€','version:1','version:2','requested:true','after'],errors:[['/wrong.js','NetworkError'],['/missing.js','NetworkError']]});
    await fixture.goto(origin+'/host');await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
    await fixture.evaluate(async({worker,scripts})=>{
      globalThis.runtimeImportRequests=[];globalThis.runtimeImportAborted=false;let version=0;
      sandstone.network.session.fetch=async(url,options)=>{
        const path=new URL(url).pathname,headers=new Headers(options.headers);runtimeImportRequests.push({path,mode:headers.get('sec-fetch-mode'),destination:headers.get('sec-fetch-dest'),credentials:options.credentials});
        if(path==='/stall.js')return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{runtimeImportAborted=true;reject(options.signal.reason);},{once:true}));
        if(path==='/redirect.js')return new Response(null,{status:302,headers:{location:'/delivered.js'}});
        if(path==='/missing.js')return new Response('steps.push("404 executed")',{status:404,headers:{'content-type':'text/javascript'}});
        const source=path==='/worker.js'?worker:path==='/change.js'?'steps.push("version:'+ ++version+'");':scripts[path];
        return new Response(source||'<body>Runtime imports',{headers:{'content-type':path.endsWith('.js')?(path==='/wrong.js'?'text/plain':'text/javascript'):'text/html','cache-control':'no-store'}});
      };
      main_frame.on_load=()=>{};await main_frame.navigate_to('https://runtime-imports.test/page');
    },{worker,scripts:Object.fromEntries(['/first.js','/nested.js','/delivered.js','/wrong.js','/after.js'].map(path=>[path,script(path,0)]))});
    assert.deepEqual(JSON.parse(await run(fixture,true)),expected);
    const requests=await fixture.evaluate(()=>runtimeImportRequests.filter(item=>item.path!=='/worker.js'&&item.path.endsWith('.js')));
    assert.equal(requests.filter(item=>item.path==='/change.js').length,2);
    for(const request of requests)assert.deepEqual({mode:request.mode,destination:request.destination,credentials:request.credentials},{mode:'no-cors',destination:'script',credentials:'include'});
    assert.deepEqual(direct,[]);
    await fixture.evaluate(()=>main_frame.eval_js('globalThis.stalledRuntimeWorker=new Worker("/worker.js");stalledRuntimeWorker.postMessage(["/stall.js"]);true'));
    await fixture.waitForFunction(()=>runtimeImportRequests.some(item=>item.path==='/stall.js'));
    await fixture.evaluate(()=>main_frame.eval_js('stalledRuntimeWorker.terminate();true'));
    await fixture.waitForFunction(()=>runtimeImportAborted);
    await fallback.goto(page.url());await fallback.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    const unavailable=await fallback.evaluate(worker=>main_frame.eval_js(`(async()=>{const worker=new Worker(URL.createObjectURL(new Blob([${JSON.stringify(worker)}],{type:'text/javascript'})));try{return await new Promise(resolve=>{worker.onmessage=event=>resolve(JSON.stringify(event.data));worker.postMessage(['https://runtime-imports.test/unknown.js'])});}finally{worker.terminate();}})()`),worker);
    assert.deepEqual(JSON.parse(unavailable),{steps:[],errors:[['https://runtime-imports.test/unknown.js','NetworkError']]});
    return ['Isolated static hosts relay message-dependent importScripts and nested imports synchronously','Runtime imports preserve requested filenames, UTF-8, large bodies and no-store reloads','Runtime import HTTP/MIME failures remain catchable without executing invalid scripts','Runtime import requests retain worker script metadata and never bypass the relay','Terminating a worker aborts its blocked runtime import'];
  }finally{await Promise.all([native.close(),fixture.close(),fallback.close()]);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
