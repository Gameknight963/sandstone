import {WorkerServiceHost} from './worker_host.mjs';
import {indexed_db} from './indexeddb.mjs';
import {set_websocket} from './network.mjs';
import {libcurl} from 'libcurl.js';
import {CookiePolicyBridge} from './cookie_policy_bridge.mjs';
import {PolicyProviders} from './policy_providers.mjs';
import {create_bootstrap_nonce} from '../bootstrap.mjs';
import {set_role} from '../rpc.mjs';
import {owner_prefix,publish_backend} from './worker_discovery.mjs';
import {crypto_service} from './crypto.mjs';
import {PortRelay} from './port_relay.mjs';
import {SharedWorkerOwners} from '../shared_worker/owners.mjs';

// This bundle runs only in a trusted host-origin worker. Authored JavaScript
// belongs in a separate opaque runtime, connected through WorkerServiceHost.
set_role('host');
const hosts=new Map(),providers=new PolicyProviders();
const cookie_policy=new CookiePolicyBridge((message,options)=>providers.request(message,options));
const identity=create_bootstrap_nonce();
const actorTargets=new Map();
const actors=new SharedWorkerOwners({createProfile:(_,initialization)=>({url:initialization.native_url}),onUIClosed:id=>actorTargets.delete(id),onError:error=>{
  try{actorTargets.get(error.ui)?.postMessage({type:'actor-error',worker:error.actor,client:error.client,message:String(error.message||'Shared worker failed'),filename:String(error.filename||'')});}catch{}
}});
let websocket,ready,publication,publishedKey,ending=false;
const owners=new Map();

function shutdown(){
  if(ending)return;ending=true;publication?.close();
  for(const watch of owners.values())watch.abort();owners.clear();
  actors.close();for(const id of [...hosts.keys()])close(id);providers.close();globalThis.close();
}

function add_owner(lease){
  if(typeof lease!=='string'||!lease.startsWith(owner_prefix))throw new TypeError('A private UI owner lease is required');
  if(owners.has(lease))return;
  const watch=new AbortController();owners.set(lease,watch);
  navigator.locks.request(lease,{signal:watch.signal},()=>{
    owners.delete(lease);if(!owners.size&&publishedKey)shutdown();
  }).catch(()=>{if(!watch.signal.aborted){owners.delete(lease);if(!owners.size&&publishedKey)shutdown();}});
}

function initialize(input,binary){
  const url=new URL(input);
  if(!['ws:','wss:'].includes(url.protocol)||url.username||url.password||url.hash)throw new TypeError('A relay WebSocket URL is required');
  if(websocket&&websocket!==url.href)throw new DOMException('Worker backend relay settings do not match','InvalidStateError');
  if(!ready){
    if(typeof binary!=='string'||!binary.startsWith('data:application/octet-stream;base64,'))throw new TypeError('Embedded relay WASM is required');
    websocket=url.href;
    ready=Promise.all([indexed_db.ready,libcurl.load_wasm(binary)]).then(()=>set_websocket(websocket));
  }
  return ready;
}

function close(id){
  const entry=hosts.get(id);if(!entry)return false;
  hosts.delete(id);for(const bridge of entry.bridges.values())bridge.close();entry.control?.close();entry.host.close();return true;
}

globalThis.onconnect=event=>{
  const port=event.ports[0];let initialized=false,actorUI;
  port.onmessage=async event=>{
    const message=event.data;if(!Number.isSafeInteger(message?.id))return;
    let opened;
    try{
      let value;
      if(message.op==='initialize'){
        await initialize(message.websocket,message.binary);initialized=true;
        value={identity,persistent:indexed_db.persistent};
      }else{
        if(!initialized)throw new DOMException('Worker backend connection is not initialized','InvalidStateError');
        if(message.op==='publish'){
          if(publishedKey)throw new DOMException('Worker backend is already published','InvalidStateError');
          if(typeof message.key!=='string'||!/^sandstone\.shared-backend\.v1:[a-f0-9]{64}$/.test(message.key))throw new TypeError('A worker backend discovery key is required');
          add_owner(message.lease);publishedKey=message.key;
          publication=await publish_backend(message.key,{url:location.href,name:globalThis.name,identity});
          if(ending){publication?.close();return;}
          value=!!publication;
        }else if(message.op==='owner'){
          if(!publication)throw new DOMException('Worker backend is not published','InvalidStateError');
          add_owner(message.lease);value=true;
        }else if(message.op==='shutdown'){
          port.postMessage({id:message.id,ok:true,value:true});shutdown();return;
        }else if(message.op==='actor-ui'){
          if(actorUI)throw new DOMException('Actor UI is already registered','InvalidStateError');
          actorUI=actors.addUI(event.ports[0],{lease:message.lease});actorTargets.set(actorUI.id,port);value={id:actorUI.id};
        }else if(message.op==='actor-acquire'){
          if(!actorUI)throw new DOMException('Actor UI is not registered','InvalidStateError');
          const actor=await actors.acquire(actorUI.id,message.document,message.descriptor,message.initialization);
          port.postMessage({id:message.id,ok:true,value:{id:actor.id,profile:actor.profile,client:actor.client,created:actor.created}},[actor.port]);return;
        }else if(message.op==='actor-release'){
          if(!actorUI)throw new DOMException('Actor UI is not registered','InvalidStateError');
          value=actors.release(actorUI.id,message.document);
        }else if(message.op==='actor-close'){
          value=actors.closeWorker(message.worker);
        }else if(message.op==='keys-store'){
          crypto_service.store(message.records);value=true;
        }else if(message.op==='keys-load'){
          value=crypto_service.load(message.handles);
        }else if(message.op==='policy'){
          providers.add(event.ports[0],{lease:message.lease,authority:message.authority});value=true;
        }else if(message.op==='open'){
          const host=new WorkerServiceHost({...message.context,cookie_policy},event.ports[0]);
          opened=host.id;hosts.set(host.id,{host,bridges:new Map()});value={id:host.id,profile:host.profile};
        }else if(message.op==='bridge'){
          const entry=hosts.get(message.worker);if(!entry)throw new DOMException('Unknown worker service','InvalidStateError');
          if(event.ports.length!==2)throw new TypeError('Two worker communication ports are required');
          const id=create_bootstrap_nonce(),bridge=new PortRelay(event.ports[0],event.ports[1],{onError:(error,direction)=>{
            try{port.postMessage({type:'bridge-error',worker:message.worker,bridge:id,direction,error:{name:String(error.name||'Error'),message:String(error.message||error)}});}catch{}
          }});entry.bridges.set(id,bridge);value=id;
        }else if(message.op==='unbridge'){
          const bridges=hosts.get(message.worker)?.bridges,bridge=bridges?.get(message.bridge);
          value=!!bridge;if(bridge){bridges.delete(message.bridge);bridge.close();}
        }else if(message.op==='control'){
          const entry=hosts.get(message.worker),control=event.ports[0];
          if(!entry)throw new DOMException('Unknown worker service','InvalidStateError');
          if(!(control instanceof MessagePort)||typeof message.nonce!=='string'||!message.nonce)throw new TypeError('A private worker control port and nonce are required');
          if(entry.control)throw new DOMException('Worker control is already attached','InvalidStateError');
          entry.control=control;control.onmessage=event=>{
            if(event.data?.sandstone_worker===message.nonce&&event.data.type==='closed')close(message.worker);
          };control.start();value=true;
        }else if(message.op==='close')value=close(message.worker);
        else throw new TypeError('Unknown worker backend operation');
      }
      port.postMessage({id:message.id,ok:true,value});
    }catch(error){
      if(opened)close(opened);
      for(const transferred of event.ports)transferred.close();
      try{port.postMessage({id:message.id,ok:false,error:{name:String(error.name||'Error'),message:String(error.message||error)}});}catch{}
    }
  };port.start();
};
