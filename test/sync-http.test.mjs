import test from 'node:test';import assert from 'node:assert/strict';import {Worker} from 'node:worker_threads';
import {create_sync_http_server} from '../src/sync_http.mjs';
import {snapshot_sync_body,restore_sync_body} from '../src/sync_http_body.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function client(fetch){
  const server=create_sync_http_server({fetch}),worker=new Worker(new URL('./sync-http-worker.mjs',import.meta.url));let complete;
  worker.on('message',packet=>{if(packet.type==='result')complete(packet);else server.receive(packet);});
  return {server,request:(options={})=>new Promise(resolve=>{complete=resolve;worker.postMessage({url:'https://app.test/resource',...options});}),async close(){server.close();await worker.terminate();}};
}
test('Synchronous worker transport streams bounded chunks without truncating binary bodies or large headers',async()=>{
  const bytes=Uint8Array.from({length:300000},(_,index)=>index%251),header='x'.repeat(70000);const api=client(async()=>new Response(bytes,{status:206,statusText:'Partial Content',headers:{'x-large':header}}));
  try{for(let index=0;index<2;index++){const result=await api.request();assert.equal(result.error,undefined);assert.deepEqual(result.response.bytes,bytes);assert.equal(result.response.status,206);assert.equal(result.response.headers.find(([key])=>key==='x-large')[1],header);await tick();assert.equal(api.server.size,0);}}finally{await api.close();}
});
test('Synchronous timeouts cancel pending transfers and late headers cannot resurrect them',async()=>{
  let release,signal,cancelled=false;const started=new Promise(resolve=>release=resolve);let finish;
  const api=client(async(url,options,requestSignal)=>{signal=requestSignal;release();return new Promise(resolve=>finish=resolve);});
  try{const pending=api.request({timeout:20});await started;const result=await pending;assert.equal(result.error.name,'TimeoutError');await tick();assert.equal(signal.aborted,true);assert.equal(api.server.size,0);
    finish(new Response(new ReadableStream({cancel(){cancelled=true;}})));await tick();await tick();assert.equal(cancelled,true);assert.equal(api.server.size,0);
  }finally{await api.close();}
});
test('Closing a synchronous transport wakes its blocked worker and aborts its relay request',async()=>{
  let opened,signal;const started=new Promise(resolve=>opened=resolve);const api=client((url,options,requestSignal)=>{signal=requestSignal;opened();return new Promise((resolve,reject)=>requestSignal.addEventListener('abort',()=>reject(requestSignal.reason),{once:true}));});
  try{const pending=api.request();await started;api.server.close();assert.equal((await pending).error.name,'NetworkError');assert.equal(signal.aborted,true);assert.equal(api.server.size,0);}finally{await api.close();}
});
test('Transfer failures reject instead of returning partial success and forged buffers cannot open requests',async()=>{
  let pulls=0;const api=client(async()=>new Response(new ReadableStream({pull(controller){if(pulls++===0)controller.enqueue(new Uint8Array([1,2]));else controller.error(new Error('transfer failed'));}})));
  try{assert.equal((await api.request()).error.name,'NetworkError');assert.equal(api.server.receive({type:'sync-http-request',id:100,url:'https://app.test/',options:{},buffer:new ArrayBuffer(32)}),true);assert.equal(api.server.size,0);}finally{await api.close();}
});
test('Synchronous body-read timeouts cancel a stalled response reader',async()=>{
  let cancelled=false;const api=client(async()=>new Response(new ReadableStream({pull(){},cancel(){cancelled=true;}})));
  try{assert.equal((await api.request({timeout:20})).error.name,'TimeoutError');await tick();assert.equal(cancelled,true);assert.equal(api.server.size,0);}finally{await api.close();}
});
test('Synchronous body snapshots retain multipart files, URLSearchParams and binary subviews',async()=>{
  const form=new FormData();form.append('name','one');form.append('file',new Blob(['bytes'],{type:'text/plain'}),'hello.txt');
  const restored=restore_sync_body(structuredClone(snapshot_sync_body(form)));assert.equal(restored.get('name'),'one');assert.equal(restored.get('file').name,'hello.txt');assert.equal(await restored.get('file').text(),'bytes');
  const params=restore_sync_body(structuredClone(snapshot_sync_body(new URLSearchParams([['a','1 2']]))));assert.equal(params.toString(),'a=1+2');
  const bytes=new Uint8Array([0,1,2,3]);const view=restore_sync_body(structuredClone(snapshot_sync_body(bytes.subarray(1,3))));assert.deepEqual([...view],[1,2]);
});
