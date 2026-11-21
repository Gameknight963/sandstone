import {listen_browser_server} from './browser-server.mjs';
import assert from 'node:assert/strict';import {createServer} from 'node:http';import {once} from 'node:events';
const loader=`if(!self.define){const modules={};const require=(url,base)=>(url=new URL(url.endsWith('.js')?url:url+'.js',base).href,modules[url]||new Promise(done=>{if('document' in self){throw new Error('Unexpected document transport')}else self.moduleURL=url,importScripts(url),done()}).then(()=>{if(!modules[url])throw new Error('Module did not register');return modules[url]}));self.define=(dependencies,factory)=>{const id=self.moduleURL||location.href;if(modules[id])return;const exports={},local=url=>require(url,id);modules[id]=Promise.resolve().then(()=>Promise.all(dependencies.map(name=>name==='exports'?exports:name==='require'?local:local(name)))).then(values=>(factory(...values),exports));};}
define(['require','./startup'],(require,startup)=>{onmessage=async event=>{const {id,paths,bytes}=event.data;try{const values=await Promise.all(paths.map(require));postMessage({id,startup:startup.value,values:values.map(value=>value.value),bytes:bytes?[...new Uint8Array(bytes)]:[]});}catch(error){postMessage({id,error:error.name});}};postMessage({ready:true});});`;
const files={'/worker.js':loader,'/startup.js':`define(['exports'],exports=>{exports.value=7});`,'/delivered/one.js':`importScripts('./nested.js');define(['exports'],exports=>{exports.value=globalThis.nestedValue});`,'/nested.js':'globalThis.nestedValue=41;','/two.js':`define(['exports'],exports=>{exports.value=2});`};
async function exercise(){
  const worker=new Worker('/worker.js'),replies=[];worker.onmessage=event=>replies.push(event.data);
  const until=async count=>{const end=Date.now()+8000;while(replies.length<count){if(Date.now()>end)throw new Error('AMD worker replies timed out: '+JSON.stringify(replies));await new Promise(resolve=>setTimeout(resolve,10));}};
  try{
    const bytes=new Uint8Array([1,2,3]).buffer;worker.postMessage({id:0,paths:[],bytes},[bytes]);const detached=bytes.byteLength===0;
    await until(2);worker.postMessage({id:1,paths:['/one.js','/two.js']});await until(3);
    worker.postMessage({id:2,paths:['/one.js']});await until(4);worker.postMessage({id:3,paths:['/missing.js']});await until(5);
    worker.postMessage({id:4,paths:['/two.js']});await until(6);return {detached,replies};
  }finally{worker.terminate();}
}
export async function verifyPromiseWorkerLoaders(page){
  const server=createServer((request,response)=>{const path=new URL(request.url,'http://local').pathname;if(path==='/one.js'){response.writeHead(302,{location:'/delivered/one.js'});response.end();return;}setTimeout(()=>{response.writeHead(files[path]||path==='/page'?200:404,{'content-type':path.endsWith('.js')?'text/javascript':'text/html','cache-control':'no-store'});response.end(files[path]||'<body>Promise worker loader');},20);});await listen_browser_server(server);
  const origin='http://127.0.0.1:'+server.address().port,native=await page.context().newPage(),fixture=await page.context().newPage(),errors=[],direct=[],artifact=page.url();
  fixture.on('pageerror',error=>errors.push(error.message));fixture.on('request',request=>{if(/^https?:/.test(request.url())&&request.url()!==artifact)direct.push(request.url());});
  try{
    await native.goto(origin+'/page');const expected=await native.evaluate(exercise);
    assert.equal(expected.detached,true);assert.deepEqual(expected.replies,[{ready:true},{id:0,startup:7,values:[],bytes:[1,2,3]},{id:1,startup:7,values:[41,2],bytes:[]},{id:2,startup:7,values:[41],bytes:[]},{id:3,error:'NetworkError'},{id:4,startup:7,values:[2],bytes:[]}]);
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.evaluate(async({origin,files})=>{globalThis.promiseWorkerRequests=[];sandstone.network.session.fetch=async url=>{const path=new URL(url).pathname;promiseWorkerRequests.push(path);if(path==='/one.js')return new Response(null,{status:302,headers:{location:'/delivered/one.js'}});await new Promise(resolve=>setTimeout(resolve,20));return new Response(files[path]||'<body>Promise worker loader',{status:files[path]||path==='/page'?200:404,headers:{'content-type':path.endsWith('.js')?'text/javascript':'text/html','cache-control':'no-store'}});};main_frame.on_load=()=>{};await main_frame.navigate_to(origin+'/page');},{origin,files});
    assert.deepEqual(await fixture.evaluate(source=>main_frame.eval_js(source),'('+exercise.toString()+')()'),expected);
    const requests=await fixture.evaluate(()=>promiseWorkerRequests);assert.equal(requests.filter(path=>path==='/startup.js').length,1);assert.equal(requests.filter(path=>path==='/one.js').length,1);assert.equal(requests.filter(path=>path==='/two.js').length,1);assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Promise AMD startup buffers immediate messages until asynchronous imports install handlers','Lazy Promise imports preserve module identities, redirects and nested synchronous imports','Promise import failures reject without breaking later requests or leaking probe errors'];
  }finally{await native.close();await fixture.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}

export async function verifyAMDServiceWorkerScripts(page){
  const fixture=await page.context().newPage(),errors=[],direct=[],origin='https://amd-installed.test';
  fixture.on('pageerror',error=>errors.push(error.message));fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
  const source=loader.slice(0,loader.indexOf('\ndefine('))+`\ndefine(['./state'],state=>{const ready=fetch('data:text/plain,ready');onmessage=event=>event.waitUntil(ready.then(()=>event.ports[0].postMessage({value:state.value})));});`;
  try{
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    const result=await fixture.evaluate(async({origin,source})=>{
      const requests=[];sandstone.network.session.fetch=async url=>{requests.push(url);const path=new URL(url).pathname;if(path==='/state.js')return new Response(null,{status:302,headers:{location:'/assets/state.js'}});return new Response(path==='/assets/state.js'?`define(['exports','./nested'],(exports,nested)=>{exports.value=nested.value});`:`define(['exports'],exports=>{exports.value=42});`,{headers:{'content-type':'text/javascript'}});};
      async function ask(profile){const owner=await sandstone.service_workers.create_service_worker_driver(profile);try{const channel=new MessageChannel(),reply=new Promise(resolve=>channel.port1.onmessage=event=>resolve(event.data));const job=owner.dispatch({event:'message',origin,data:null,ports:[channel.port2]});await job.result;await job.lifetime;const value=await reply;channel.port1.close();await job.release();return {value,scripts:await owner.scripts()};}finally{owner.close();}}
      const profile={scope:origin+'/',scriptURL:origin+'/worker.js',source,type:'classic'},fresh=await ask(profile),captured=[...requests];requests.length=0;sandstone.network.session.fetch=async url=>{requests.push(url);throw new TypeError('Restoring must not fetch scripts');};
      const restored=await ask({...profile,scripts:fresh.scripts,restoring:true});return {fresh:fresh.value,restored:restored.value,captured,network:requests,scripts:fresh.scripts.map(script=>new URL(script.url).pathname).sort()};
    },{origin,source});
    assert.deepEqual(result,{fresh:{value:42},restored:{value:42},captured:[origin+'/state.js',origin+'/assets/state.js',origin+'/nested.js'],network:[],scripts:['/nested.js','/state.js','/worker.js']});assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Classic AMD service workers discover declared dependencies without executing startup probes','AMD service workers retain requested module bases across redirected imports','Installed AMD service workers restart offline from their complete script snapshots'];
  }finally{await fixture.close();}
}
