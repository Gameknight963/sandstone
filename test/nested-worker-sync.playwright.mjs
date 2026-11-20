import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';

const child=`onmessage=event=>{
  const state=new Int32Array(event.data);
  setTimeout(()=>{Atomics.wait(state,0,0,3000);let result;
  try{
    importScripts('/imports/first.js');importScripts('/imports/first.js');
    const xhr=new XMLHttpRequest();xhr.open('POST','/echo',false);xhr.responseType='json';xhr.send(new Uint8Array([9,1,2,8]).subarray(1,3));
    const binary=new XMLHttpRequest();binary.open('GET','/bytes',false);binary.responseType='arraybuffer';binary.send();
    const bytes=new Uint8Array(binary.response);
    const failures=[];
    for(const path of ['/slow','/error']){const request=new XMLHttpRequest();request.open('GET',path,false);request.timeout=20;try{request.send();failures.push('none');}catch(error){failures.push(error.name);}}
    try{importScripts('/missing.js');failures.push('none');}catch(error){failures.push(error.name);}
    result={imports:self.importCount,echo:xhr.response,binary:{length:bytes.length,first:bytes[0],last:bytes.at(-1)},failures};
    Atomics.store(state,1,1);
  }catch(error){result={error:error.name+': '+error.message};Atomics.store(state,1,-1);}
  postMessage(result);Atomics.store(state,2,1);Atomics.notify(state,2);
  },0);postMessage('ready');
};`;
const parent=`const child=new Worker('/child.js');let ready,done;
const started=new Promise(resolve=>ready=resolve),completed=new Promise(resolve=>done=resolve);
child.onmessage=event=>event.data==='ready'?ready():done(event.data);
onmessage=async()=>{const buffer=new SharedArrayBuffer(12),state=new Int32Array(buffer);child.postMessage(buffer);await started;
Atomics.store(state,0,1);Atomics.notify(state,0);
const wait=Atomics.wait(state,2,0,3000),value=Atomics.load(state,1);
if(wait==='timed-out'){child.terminate();postMessage({completed:false,value});return;}
const result=await completed;child.terminate();postMessage({completed:true,value,result});};`;
const run=`new Promise((resolve,reject)=>{
  const worker=new Worker('/parent.js'),timer=setTimeout(()=>{worker.terminate();reject(new Error('Nested synchronous worker timed out'));},12000);
  worker.onmessage=event=>{clearTimeout(timer);worker.terminate();resolve(event.data);};
  worker.onerror=event=>{clearTimeout(timer);worker.terminate();reject(new Error(event.message));};worker.postMessage('run');
})`;
const bytes=Uint8Array.from({length:150000},(_,index)=>index%251);

export async function verifyNestedWorkerSync(page){
  const html=await readFile(new URL('../example/bundled.html',import.meta.url));
  const assets=new Map([
    ['/parent.js',parent],['/child.js',child],
    ['/held-parent.js',"const child=new Worker('/held.js');child.onmessage=()=>child.postMessage('run');"],
    ['/held.js',"postMessage('ready');onmessage=()=>{const xhr=new XMLHttpRequest();xhr.open('GET','/hold',false);xhr.send();};"],
    ['/imports/first.js',"importScripts('/imports/second.js');"],
    ['/imports/second.js','self.importCount=(self.importCount||0)+1;']
  ]);
  const nativeRequests=[];
  const server=createServer(async(request,response)=>{
    nativeRequests.push(request.url);
    const path=new URL(request.url,'http://localhost').pathname;
    response.setHeader('cross-origin-opener-policy','same-origin');response.setHeader('cross-origin-embedder-policy','require-corp');
    if(path==='/host'){response.setHeader('content-type','text/html');response.end(html);return;}
    if(assets.has(path)){response.setHeader('content-type','text/javascript');if(path==='/child.js')response.setHeader('referrer-policy','origin');response.end(assets.get(path));return;}
    if(path==='/echo'){
      const chunks=[];for await(const chunk of request)chunks.push(chunk);
      response.setHeader('content-type','application/json');response.end(JSON.stringify({bytes:[...Buffer.concat(chunks)],referrerPath:request.headers.referer?new URL(request.headers.referer).pathname:null}));return;
    }
    if(path==='/bytes'){response.setHeader('content-type','application/octet-stream');response.end(bytes);return;}
    if(path==='/slow'){setTimeout(()=>response.end('late'),100);return;}
    if(path==='/error'){request.socket.destroy();return;}
    if(path==='/missing.js'){response.writeHead(404,{'content-type':'text/javascript'});response.end();return;}
    response.setHeader('content-type','text/html');response.end('<!doctype html><body>Nested synchronous workers');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage(),fixture=await page.context().newPage(),errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));
  try{
    await native.goto(origin+'/native');const expected=await native.evaluate(source=>eval(source),run);
    assert.equal(expected.completed,true,JSON.stringify(nativeRequests));assert.equal(expected.value,1);assert.deepEqual(expected.result.echo,{bytes:[1,2],referrerPath:'/'});assert.equal(expected.result.imports,2);
    await fixture.goto(origin+'/host');await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
    await fixture.evaluate(async({assets,bytes})=>{
      const scripts=new Map(assets);
      sandstone.network.session.fetch=async(url,options={})=>{
        const path=new URL(url).pathname;
        if(path==='/hold'){
          globalThis.nestedHeldStarted=true;
          return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{globalThis.nestedHeldAborted=true;reject(options.signal.reason);},{once:true}));
        }
        if(path==='/slow'){await new Promise(resolve=>setTimeout(resolve,100));return new Response('late');}
        if(path==='/error')throw new TypeError('Network failed');
        if(path==='/missing.js')return new Response('',{status:404,headers:{'content-type':'text/javascript'}});
        if(path==='/echo'){const referrer=new Headers(options.headers).get('referer');return Response.json({bytes:[...new Uint8Array(options.body)],referrerPath:referrer?new URL(referrer).pathname:null});}
        if(path==='/bytes')return new Response(Uint8Array.from(bytes),{headers:{'content-type':'application/octet-stream'}});
        return new Response(scripts.get(path)||'<!doctype html><body>Nested synchronous workers',{headers:{'content-type':scripts.has(path)?'text/javascript':'text/html',...(path==='/child.js'?{'referrer-policy':'origin'}:{})}});
      };
      await main_frame.navigate_to('https://nested-sync.test/page');
    },{assets:[...assets],bytes:[...bytes]});
    const actual=JSON.parse(await fixture.evaluate(source=>main_frame.eval_js('(async()=>JSON.stringify(await ('+source+')))()'),run));
    assert.deepEqual(actual,expected);
    await fixture.evaluate(()=>main_frame.eval_js("globalThis.heldWorker=new Worker('/held-parent.js');true"));
    await fixture.waitForFunction(()=>globalThis.nestedHeldStarted);
    await fixture.evaluate(()=>main_frame.eval_js('heldWorker.terminate();true'));
    await fixture.waitForFunction(()=>globalThis.nestedHeldAborted);
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Nested workers import scripts and relay synchronous XHR while their parent waits in Atomics.wait','Nested synchronous requests preserve binary bodies, worker referrer policies, repeated imports, timeouts and network failures','Terminating a worker tree aborts a nested synchronous relay request'];
  }finally{await fixture.close();await nativeContext.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await page.bringToFront();}
}
