import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';

const worker=`onmessage=async()=>{try{
const root=await navigator.storage.getDirectory(),file=await root.getFileHandle('sync.bin',{create:true}),handle=await file.createSyncAccessHandle(),result={tag:Object.prototype.toString.call(handle),typed:handle instanceof FileSystemSyncAccessHandle};
result.written=handle.write(new Uint8Array([9,1,2,3,8]).subarray(1,4),{at:2});result.size=handle.getSize();
const bytes=new Uint8Array(8).fill(99);result.read=handle.read(bytes.subarray(2,7),{at:1});result.bytes=[...bytes];
const hidden=Uint8Array.of(9,4,5,8).subarray(1,3),output=new DataView(new ArrayBuffer(2));
for(const value of [hidden,output])for(const key of ['buffer','byteOffset','byteLength'])Object.defineProperty(value,key,{get(){throw new Error('Authored buffer properties must not be read');}});
result.hiddenWrite=handle.write(hidden,{at:0});result.hiddenRead=handle.read(output,{at:0});result.hiddenValue=[output.getUint8(0),output.getUint8(1)];
const shared=new SharedArrayBuffer(2);new Uint8Array(shared).set([6,7]);result.sharedWrite=handle.write(shared,{at:0});new Uint8Array(shared).fill(0);result.sharedRead=handle.read(shared,{at:0});result.sharedValue=[...new Uint8Array(shared)];
let atReads=0;result.optionWrite=handle.write(shared,{get at(){atReads++;new Uint8Array(shared).set([8,9]);return 0;}});new Uint8Array(shared).fill(0);result.optionRead=handle.read(shared,{get at(){atReads++;return 0;}});result.optionValue=[...new Uint8Array(shared)];result.atReads=atReads;
result.append=handle.write(new DataView(new Uint8Array([7,8]).buffer));handle.truncate(4);result.truncated=handle.getSize();result.flush=typeof handle.flush();
for(const [key,run] of [['locked',()=>file.createSyncAccessHandle()],['writable',()=>file.createWritable()],['clone',()=>structuredClone(handle)]])try{await run();result[key]='none';}catch(error){result[key]=error.name;}
handle.close();handle.close();try{handle.read(new Uint8Array(1));}catch(error){result.closed=error.name;}
result.file=[...new Uint8Array(await(await file.getFile()).arrayBuffer())];postMessage(result);
}catch(error){postMessage({error:error.name+': '+error.message});}};`;
const run=`new Promise((resolve,reject)=>{const worker=new Worker('/worker.js');worker.onmessage=event=>{worker.terminate();resolve(event.data);};worker.onerror=event=>{worker.terminate();reject(new Error(event.message));};setTimeout(()=>{worker.terminate();reject(new Error('Synchronous files timed out'));},15000);worker.postMessage('run');})`;
export async function verifySynchronousFiles(page){
  const html=await readFile(new URL('../example/bundled.html',import.meta.url));
  const server=createServer((request,response)=>{
    response.setHeader('cross-origin-opener-policy','same-origin');response.setHeader('cross-origin-embedder-policy','require-corp');
    if(request.url==='/host'){response.setHeader('content-type','text/html');response.end(html);}
    else if(request.url==='/worker.js'){response.setHeader('content-type','text/javascript');response.end(worker);}
    else{response.setHeader('content-type','text/html');response.end('<!doctype html><body>Files');}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage(),fixture=await page.context().newPage(),errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));fixture.on('console',message=>{if(message.type()==='error'&&message.text()!=='Permissions policy violation: unload is not allowed in this document.')errors.push(message.text());});
  try{
    await native.goto(origin+'/native');const expected=await native.evaluate(source=>eval(source),run);assert.equal(expected.written,3);assert.equal(expected.locked,'NoModificationAllowedError');
    await fixture.goto(origin+'/host');await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
    await fixture.evaluate(async worker=>{sandstone.network.session.fetch=async url=>new Response(new URL(url).pathname==='/worker.js'?worker:'<!doctype html><body>Files',{headers:{'content-type':new URL(url).pathname==='/worker.js'?'text/javascript':'text/html'}});await main_frame.navigate_to('https://filesystem-sync.test/page');},worker);
    const actual=JSON.parse(await fixture.evaluate(source=>main_frame.eval_js('(async()=>JSON.stringify(await ('+source+')))()'),run));assert.deepEqual(actual,expected);
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Isolated static hosts provide native-compatible synchronous worker file reads, writes, cursor and flush','Synchronous file leases exclude other writers and preserve close and clone errors','Synchronous files honor native BufferSource ranges, shared buffers and one-time option conversions'];
  }finally{await fixture.close();await nativeContext.close();await new Promise(resolve=>server.close(resolve));await page.bringToFront();}
}
