import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {retained_worker_main} from './retained-worker-fixture.mjs';
import {shared_worker_registry_main,shared_worker_identity_script} from './shared-worker-registry.playwright.mjs';

// This is trusted host code, never a remote site's worker. Exercise the service
// bundle without a Window before giving shared remote runtimes a durable owner.
function shared_host_main(){
  let connections=0;
  const service=sandstone.controller.indexed_db;
  const origin='https://shared-host.test';
  let factory,Range;try{factory=globalThis.indexedDB;Range=globalThis.IDBKeyRange;}catch{}
  onconnect=event=>{
    const port=event.ports[0],id=++connections,client='host-worker:'+id;
    const command=cmd=>service.command(client,origin,cmd);
    async function wait(target,type){
      for(;;)for(const event of await service.poll(client,origin)){
        if(event.type==='error'||event.type==='abort')throw new Error(JSON.stringify(event));
        if(event.type==='upgradeneeded'){
          await command({op:'schema',transaction:'upgrade',method:'createObjectStore',store:'records'});
          await command({op:'release',transaction:'upgrade'});
        }
        if(event.target===target&&event.type===type)return event.value;
      }
    }
    port.onmessage=async event=>{
      try{
        await service.ready;await sandstone.libcurl.load_wasm();
        const url=new URL('/host-worker/data',location.href);
        const transportAPI=id%2?sandstone.libcurl:sandstone.network;
        transportAPI.set_websocket(url.origin.replace(/^http/,'ws')+'/');
        const response=await sandstone.network.fetch(url.href,{mode:'same-origin',credentials:'omit'},{url:url.href,top_url:url.href});
        const transport=await response.text();
        await command({op:'open',name:'shared-host',version:1,database:'db',request:'open',transaction:'upgrade'});
        await wait('open','success');
        const writing=event.data==='write';
        await command({op:'transaction',database:'db',stores:['records'],mode:writing?'readwrite':'readonly',transaction:'tx'});
        await command({op:'request',transaction:'tx',store:'records',method:writing?'put':'get',args:writing?[new Uint8Array([17,34,51]),'saved']:['saved'],request:'value'});
        const value=await wait('value','success');
        await command({op:'release',transaction:'tx'});await wait('tx','complete');
        await command({op:'close',database:'db'});service.disconnect(client);
        port.postMessage({id,scope:globalThis.constructor.name,persistent:service.persistent,nativeFactory:service.factory===factory,nativeRange:service.Range===Range,transport,value:writing?null:value?Array.from(value):null});
      }catch(error){service.disconnect(client);port.postMessage({error:{name:error.name,message:error.message,stack:error.stack}});}
    };
    port.start();
  };
}

export async function host_worker_fixture(){
  const bundle=await readFile(new URL('../dist/sandstone.js',import.meta.url));
  const runtime=await readFile(new URL('../dist/sandstone_frame.js',import.meta.url));
  const main='importScripts("/host-worker/bundle.js");('+shared_host_main.toString()+')();';
  return {handle(request,response){
    const path=new URL(request.url,'http://fixture').pathname;
    if(!path.startsWith('/host-worker/'))return false;
    let body,type='text/javascript';
    if(path==='/host-worker/bundle.js')body=bundle;
    else if(path==='/host-worker/registry.js')body='importScripts("/host-worker/bundle.js");('+shared_worker_registry_main.toString()+')();';
    else if(['/host-worker/identity-worker.js','/host-worker/identity-other.js','/host-worker/identity-module.js'].includes(path))body=shared_worker_identity_script;
    else if(path==='/host-worker/identity-redirect'){response.writeHead(302,{location:'/host-worker/identity-worker.js','cache-control':'no-store'});response.end();return true;}
    else if(path==='/host-worker/runtime.js')body=runtime;
    else if(path==='/host-worker/retained.js')body='importScripts("/host-worker/bundle.js");('+retained_worker_main.toString()+')();';
    else if(path==='/host-worker/retained-denied.js')body='Object.defineProperty(globalThis,"indexedDB",{get(){throw new DOMException("Storage denied","SecurityError");}});importScripts("/host-worker/bundle.js");('+retained_worker_main.toString()+')();';
    else if(path==='/host-worker/shared.js')body=main;
    else if(path==='/host-worker/shared-denied.js')body='Object.defineProperty(globalThis,"indexedDB",{get(){throw new DOMException("Storage denied","SecurityError");}});'+main;
    else if(path==='/host-worker/data'){body='relayed host data';type='text/plain';}
    else if(path==='/host-worker/page'){body='<!doctype html><body>Trusted shared host controls';type='text/html';}
    else{response.writeHead(404);response.end();return true;}
    response.writeHead(200,{'content-type':type});response.end(body);return true;
  }};
}

export async function verify_host_worker_services(browser,origin){
  const context=await browser.newContext();
  const connect=(page,denied,name,operation)=>page.evaluate(({denied,name,operation})=>new Promise((resolve,reject)=>{
    const worker=new SharedWorker('/host-worker/shared'+(denied?'-denied':'')+'.js',{name});
    (globalThis.hostWorkers??=[]).push(worker);
    const timer=setTimeout(()=>reject(new Error('Trusted host worker timed out')),15000);
    worker.onerror=event=>{event.preventDefault();clearTimeout(timer);reject(new Error(event.message));};
    worker.port.onmessage=event=>{clearTimeout(timer);event.data.error?reject(new Error(JSON.stringify(event.data.error))):resolve(event.data);};
    worker.port.postMessage(operation);
  }),{denied,name,operation}),results=[];
  try{
    for(const denied of [false,true]){
      const first=await context.newPage(),second=await context.newPage();
      await first.goto(origin+'/host-worker/page');await second.goto(origin+'/host-worker/page');
      const name='host-services-'+denied;
      const expected=(id,value)=>({id,scope:'SharedWorkerGlobalScope',persistent:!denied,nativeFactory:!denied,nativeRange:!denied,transport:'relayed host data',value});
      assert.deepEqual(await connect(first,denied,name,'write'),expected(1,null));
      assert.deepEqual(await connect(second,denied,name,'read'),expected(2,[17,34,51]));
      await first.close();
      assert.deepEqual(await connect(second,denied,name,'read'),expected(3,[17,34,51]));
      // A fresh worker realm proves native durability, while denied storage
      // retains its isolated in-memory fallback only for the existing owner.
      assert.deepEqual(await connect(second,denied,name+'-fresh','read'),expected(1,denied?null:[17,34,51]));
      await second.close();results.push('Trusted worker host networking and '+(denied?'denied-storage fallback':'durable IndexedDB')+' survive the creating page');
    }
    return results;
  }finally{await context.close();}
}
