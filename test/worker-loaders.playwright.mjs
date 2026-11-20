import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';

const worker=`const manager={getConfig:()=>({getOptionsLiteral:()=>({})})};
class Loader{load(manager,url,loaded,failed){const options=manager.getConfig().getOptionsLiteral();try{importScripts(url);loaded()}catch(error){failed(error)}}}
const original=importScripts;globalThis.importCalls=0;globalThis.importArgs=[];globalThis.importScripts=function(...paths){importCalls++;importArgs.push(paths.map(String));return original(...paths);};
onmessage=event=>{const {id,path,bytes}=event.data;new Loader().load(manager,path,()=>postMessage({id,value:globalThis.answer,calls:importCalls,paths:importArgs,bytes:bytes?[...new Uint8Array(bytes)]:[],source:Loader.prototype.load.toString()}),error=>postMessage({id,error:error.name,calls:importCalls}));};postMessage({ready:true});`;
const files={
  '/worker.js':worker,
  '/delivered/runtime.js':'importScripts("./nested.js");globalThis.answer=globalThis.seed+1;',
  '/nested.js':'globalThis.seed=(globalThis.seed||0)+41;'
};
export async function verifyWorkerLoaders(page){
  const server=createServer((request,response)=>{
    const path=new URL(request.url,'http://local').pathname;
    if(path==='/assets/lazy.js'){response.writeHead(302,{location:'/delivered/runtime.js'});response.end();return;}
    response.writeHead(files[path]||path==='/page'?200:404,{'content-type':path.endsWith('.js')?'text/javascript':'text/html','cache-control':'no-store'});response.end(files[path]||'<body>Worker loader fixture');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  const native=await page.context().newPage(),fixture=await page.context().newPage(),direct=[],errors=[];
  const artifact=page.url();fixture.on('request',request=>{if(/^https?:/.test(request.url())&&request.url()!==artifact)direct.push(request.url());});fixture.on('pageerror',error=>errors.push(error.message));
  const read=(target,proxy,source)=>proxy?target.evaluate(source=>main_frame.eval_js(source),source):target.evaluate(source=>globalThis.eval(source),source);
  async function verify(target,proxy){
    await read(target,proxy,`globalThis.workerReplies=[];globalThis.lateWorker=new Worker('/worker.js');lateWorker.onmessage=event=>workerReplies.push(event.data);true`);
    const wait=async expression=>{const deadline=Date.now()+10000;while(!await read(target,proxy,expression)){if(Date.now()>deadline)throw new Error('Worker loader state timed out: '+expression);await new Promise(resolve=>setTimeout(resolve,10));}};
    await wait('workerReplies.length===1');
    const detached=await read(target,proxy,`(()=>{const bytes=new Uint8Array([1,2,3]).buffer;lateWorker.postMessage({id:1,path:'/assets/lazy.js',bytes},[bytes]);return bytes.byteLength===0;})()`);assert.equal(detached,true);
    await wait('workerReplies.length===2');
    await read(target,proxy,`lateWorker.postMessage({id:2,path:'/assets/lazy.js'});lateWorker.postMessage({id:3,path:'/missing.js'});true`);
    await wait('workerReplies.length===4');
    const result=JSON.parse(await read(target,proxy,'JSON.stringify(workerReplies)'));await read(target,proxy,'lateWorker.terminate();true');return result;
  }
  try{
    await native.goto(origin+'/page');const expected=await verify(native,false);
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.evaluate(async({origin,files})=>{
      sandstone.network.session.fetch=async url=>{const path=new URL(url).pathname;if(path==='/assets/lazy.js')return new Response(null,{status:302,headers:{location:'/delivered/runtime.js'}});return new Response(files[path]||'<body>Worker loader fixture',{status:files[path]||path==='/page'?200:404,headers:{'content-type':path.endsWith('.js')?'text/javascript':'text/html','cache-control':'no-store'}});};
      main_frame.on_load=()=>{};await main_frame.navigate_to(origin+'/page');
    },{origin,files});
    const actual=await verify(fixture,true);assert.deepEqual(actual,expected);assert.equal(actual[1].value,42);assert.equal(actual[2].value,83);assert.deepEqual(actual[3],{id:3,error:'NetworkError',calls:5});assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['AMD worker callback transports load post-startup scripts through the relay','Late script redirects retain native worker-relative nested imports and repeated execution','Lazy worker loading preserves transferred buffers, import overrides, callbacks and authored function source','Failed lazy worker requests reach the loader error callback without direct HTTP fallback'];
  }finally{await Promise.all([native.close(),fixture.close()]);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
