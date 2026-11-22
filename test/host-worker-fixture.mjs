import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {WebSocketServer} from '../example/node_modules/ws/wrapper.mjs';
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

function prepared_classic(){
  onconnect=event=>{
    const port=event.ports[0];port.onmessage=async event=>{
      try{
        if(event.data==='missing'){try{globalThis.loadMissing();}catch(error){port.postMessage({missing:error.name});}return;}
        const headers=await(await fetch('/host-worker/prepare-echo',{credentials:'include'})).json();
        const target=new URL('/host-worker/socket',location.href);target.protocol=target.protocol==='https:'?'wss:':'ws:';
        const socket=new WebSocket(target.href,['retained']);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=()=>reject(new Error('Prepared worker socket failed'));});
        const protocol=socket.protocol;socket.close();
        port.postMessage({url:location.href,origin,dependency:globalThis.preparedDependency,local:globalThis.preparedLocal,headers,protocol});
      }catch(error){port.postMessage({error:error.message});}
    };port.start();
  };
}

export async function host_worker_fixture(){
  const preparationRequests=[],heldPreparations=new Set();
  const heldCookies=new Set();
  const heldWebSockets=new Set();
  const websockets=new WebSocketServer({noServer:true,handleProtocols:protocols=>protocols.has('retained')?'retained':false});
  websockets.on('headers',(headers,request)=>{
    headers.push('Set-Cookie: worker_socket=handshake; HttpOnly; SameSite=None; Secure; Path=/','Set-Cookie: socket_scoped=private; HttpOnly; SameSite=None; Secure; Path=/host-worker/socket-only');
    if(request.url==='/host-worker/socket-held')headers.push('Set-Cookie: worker_session=restored; HttpOnly; SameSite=None; Secure; Path=/','Set-Cookie: fresh=deleted; Max-Age=0; SameSite=None; Secure; Path=/');
  });
  websockets.on('connection',(socket,request)=>{
    const cookies=(request.headers.cookie||'').split('; ');
    socket.send(JSON.stringify({origin:request.headers.origin,session:cookies.find(value=>value.startsWith('worker_session='))?.slice('worker_session='.length),blocked:cookies.includes('blocked=strict')}));
    socket.on('message',(value,binary)=>socket.send(value,{binary}));
  });
  const bundle=await readFile(new URL('../dist/sandstone.js',import.meta.url));
  const runtime=await readFile(new URL('../dist/sandstone_frame.js',import.meta.url));
  const main='importScripts("/host-worker/bundle.js");('+shared_host_main.toString()+')();';
  return {preparationRequests,heldPreparations,releasePreparations(){for(const response of heldPreparations){response.writeHead(200,{'content-type':'text/javascript'});response.end('export const prepared=true;');}heldPreparations.clear();},upgrade(request,socket,head){
    const path=new URL(request.url,'http://fixture').pathname;
    if(path==='/host-worker/socket-held'){
      const held={request,socket,head};heldWebSockets.add(held);socket.on('close',()=>heldWebSockets.delete(held));return true;
    }
    if(path==='/host-worker/socket-refused'){
      socket.end('HTTP/1.1 403 Forbidden\r\nSet-Cookie: worker_refused=kept; HttpOnly; SameSite=None; Secure; Path=/\r\nContent-Length: 0\r\n\r\n');return true;
    }
    if(path!=='/host-worker/socket')return false;
    websockets.handleUpgrade(request,socket,head,ws=>websockets.emit('connection',ws,request));return true;
  },handle(request,response){
    const path=new URL(request.url,'http://fixture').pathname;
    if(!path.startsWith('/host-worker/'))return false;
    if(path.startsWith('/host-worker/prepare'))preparationRequests.push({path,headers:{...request.headers}});
    let body,type='text/javascript';
    if(path==='/host-worker/prepare-entry.js'){response.writeHead(302,{location:'/host-worker/prepared/entry.js','set-cookie':'prepare_after=visible; HttpOnly; SameSite=Strict; Path=/host-worker/','cache-control':'no-store'});response.end();return true;}
    if(path==='/host-worker/prepared/entry.js'){response.writeHead(200,{'content-type':'text/javascript','referrer-policy':'origin','cache-control':'no-store'});response.end('importScripts("./dependency.js","blob:null/prepared-local");globalThis.loadMissing=()=>importScripts("/host-worker/prepare-failed.js");('+prepared_classic.toString()+')();');return true;}
    if(path==='/host-worker/prepared/dependency.js')body='globalThis.preparedDependency="relayed";';
    else if(path==='/host-worker/prepare-failed.js'){response.writeHead(404,{'content-type':'text/javascript'});response.end('throw new Error("must not execute");');return true;}
    else if(path==='/host-worker/prepare-module.js')body='import "/host-worker/prepare-never.js";export const prepared=true;';
    else if(path==='/host-worker/prepare-mime.js'){body='0';type='text/plain';}
    else if(path==='/host-worker/prepare-echo'){body=JSON.stringify(request.headers);type='application/json';}
    else if(path==='/host-worker/prepare-held.js'){heldPreparations.add(response);response.on('close',()=>heldPreparations.delete(response));return true;}
    else if(path==='/host-worker/bundle.js')body=bundle;
    else if(path==='/host-worker/registry.js')body='importScripts("/host-worker/bundle.js");('+shared_worker_registry_main.toString()+')();';
    else if(['/host-worker/identity-worker.js','/host-worker/identity-other.js','/host-worker/identity-module.js'].includes(path))body=shared_worker_identity_script;
    else if(path==='/host-worker/identity-redirect'){response.writeHead(302,{location:'/host-worker/identity-worker.js','cache-control':'no-store'});response.end();return true;}
    else if(path==='/host-worker/runtime.js')body=runtime;
    else if(path==='/host-worker/retained.js')body='importScripts("/host-worker/bundle.js");('+retained_worker_main.toString()+')();';
    else if(path==='/host-worker/retained-denied.js')body='Object.defineProperty(globalThis,"indexedDB",{get(){throw new DOMException("Storage denied","SecurityError");}});importScripts("/host-worker/bundle.js");('+retained_worker_main.toString()+')();';
    else if(path==='/host-worker/shared.js')body=main;
    else if(path==='/host-worker/shared-denied.js')body='Object.defineProperty(globalThis,"indexedDB",{get(){throw new DOMException("Storage denied","SecurityError");}});'+main;
    else if(path==='/host-worker/data'){body='relayed host data';type='text/plain';}
    else if(path==='/host-worker/socket-status'){response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(heldWebSockets.size));return true;}
    else if(path==='/host-worker/socket-release'){
      for(const {request,socket,head} of heldWebSockets)websockets.handleUpgrade(request,socket,head,ws=>websockets.emit('connection',ws,request));
      heldWebSockets.clear();response.writeHead(204);response.end();return true;
    }
    else if(path==='/host-worker/cookie-held'){heldCookies.add(response);response.on('close',()=>heldCookies.delete(response));return true;}
    else if(path==='/host-worker/cookie-status'){response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(heldCookies.size));return true;}
    else if(path==='/host-worker/cookie-release'){
      for(const held of heldCookies){held.writeHead(200,{'set-cookie':['worker_session=restored; HttpOnly; SameSite=None; Secure; Path=/','fresh=deleted; Max-Age=0; SameSite=None; Secure; Path=/'],'cache-control':'no-store'});held.end('released');}
      heldCookies.clear();response.writeHead(204);response.end();return true;
    }
    else if(path==='/host-worker/cookie-start'){response.writeHead(302,{location:'/host-worker/cookie-end','set-cookie':'worker_redirect=yes; HttpOnly; SameSite=None; Secure; Path=/','cache-control':'no-store'});response.end();return true;}
    else if(path==='/host-worker/cookie-end'){response.writeHead(200,{'content-type':'text/plain','cache-control':'no-store'});response.end(request.headers.cookie||'');return true;}
    else if(path==='/host-worker/page'){body='<!doctype html><body>Trusted shared host controls';type='text/html';}
    else{response.writeHead(404);response.end();return true;}
    response.writeHead(200,{'content-type':type+'; charset=utf-8'});response.end(body);return true;
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
