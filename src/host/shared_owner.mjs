import {create_bootstrap_nonce} from '../bootstrap.mjs';
import {hold_lock} from './worker_discovery.mjs';
import {delegate_prefix} from '../shared_worker/owners.mjs';

// Only this trusted constructor bootstrap runs in the host origin. Remote
// worker code must run in an opaque data: worker, never a host-origin blob.
function owner_main(nonce){
  let control,profile;const workers=new Map(),NativeWorker=SharedWorker;
  addEventListener('message',event=>{
    if(control||!event.isTrusted||event.source!==parent||event.data?.sandstone_owner!==nonce||!event.ports[0])return;
    control=event.ports[0];profile=event.data.profile;
    control.onmessage=event=>{
      const message=event.data;if(message?.type!=='connect'||!Number.isSafeInteger(message.id))return;
      try{
        // Virtual module and extended lifetimes belong to the runtime/registry.
        // A native extension would outlive disposal of this owner document.
        const worker=new NativeWorker(profile.url,{name:profile.name,credentials:profile.credentials,extendedLifetime:false,type:'classic'});
        workers.set(message.id,worker);
        worker.onerror=event=>{
          event.preventDefault();
          control.postMessage({type:'error',nonce,client:message.id,message:String(event.message||'Shared worker failed'),filename:String(event.filename||'')});
        };
        control.postMessage({type:'reply',nonce,id:message.id,ok:true},[worker.port]);
      }catch(error){control.postMessage({type:'reply',nonce,id:message.id,ok:false,error:{name:String(error.name||'Error'),message:String(error.message||error)}});}
    };control.start();control.postMessage({type:'ready',nonce});
  });
  globalThis.__sandstone_owner_ready__=nonce;
}

export async function create({url,name='',credentials='same-origin',extendedLifetime=false,signal}={}){
  signal?.throwIfAborted();
  if(!globalThis.document||!['http:','https:'].includes(globalThis.location?.protocol)||typeof SharedWorker!=='function')throw new DOMException('Native shared worker ownership requires a hosted page','NotSupportedError');
  const target=new URL(url);
  if(target.protocol!=='data:')throw new DOMException('Shared worker runtimes must use an opaque data URL','SecurityError');
  if(typeof name!=='string'||!['omit','same-origin','include'].includes(credentials)||typeof extendedLifetime!=='boolean')throw new TypeError('Invalid shared worker owner profile');
  const profile={url:target.href,name,credentials,extendedLifetime},nonce=create_bootstrap_nonce(),iframe=document.createElement('iframe'),events=new EventTarget(),pending=new Map();
  let control,observer,closed=false,sequence=0,resolveClosed,resolveReady,rejectReady;
  const ended=new Promise(resolve=>{resolveClosed=resolve;}),ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const close=(error=new DOMException('Shared worker owner is closed','AbortError'))=>{
    if(closed)return;closed=true;
    signal?.removeEventListener('abort',abort);iframe.removeEventListener('load',loaded);observer?.disconnect();control?.close();iframe.remove();rejectReady(error);
    for(const call of pending.values())call.reject(error);pending.clear();resolveClosed(error);
  };
  const abort=()=>close(signal.reason);
  const receive=event=>{
    const message=event.data;if(message?.nonce!==nonce)return;
    if(message.type==='ready'){resolveReady();return;}
    if(message.type==='error'){events.dispatchEvent(new MessageEvent('error',{data:message}));return;}
    const call=pending.get(message.id);if(message.type!=='reply'||!call){for(const port of event.ports)port.close();return;}
    pending.delete(message.id);
    if(message.ok&&event.ports[0])call.resolve({id:message.id,port:event.ports[0]});
    else{const error=new Error(message.error?.message||'Shared worker construction failed');error.name=message.error?.name||'Error';call.reject(error);}
  };
  const loaded=()=>{
    if(closed||control)return;
    try{
      if(iframe.contentWindow.location.href!=='about:srcdoc')return;
      if(iframe.contentWindow.__sandstone_owner_ready__!==nonce)throw new DOMException('Shared worker owner bootstrap was blocked','SecurityError');
      const channel=new MessageChannel();control=channel.port1;control.onmessage=receive;control.start();
      iframe.contentWindow.postMessage({sandstone_owner:nonce,profile},location.origin,[channel.port2]);
    }catch(error){close(error);}
  };
  const connect=()=>new Promise((resolve,reject)=>{
    if(closed){reject(new DOMException('Shared worker owner is closed','InvalidStateError'));return;}
    const id=++sequence;pending.set(id,{resolve,reject});
    try{control.postMessage({type:'connect',id});}catch(error){pending.delete(id);reject(error);}
  });
  iframe.hidden=true;iframe.setAttribute('aria-hidden','true');
  iframe.srcdoc='<!doctype html><script>('+owner_main.toString()+')('+JSON.stringify(nonce)+');</scr'+'ipt>';
  iframe.addEventListener('load',loaded);signal?.addEventListener('abort',abort,{once:true});
  try{
    if(signal?.aborted)abort();else{
      (document.body||document.documentElement).append(iframe);
      observer=new MutationObserver(()=>{if(!iframe.isConnected)close(new DOMException('Shared worker owner document was removed','AbortError'));});
      observer.observe(document,{childList:true,subtree:true});
    }
    await ready;return {connect,close,closed:ended,events,get isClosed(){return closed;}};
  }catch(error){close(error);throw error;}
}

export function serve(port){
  if(!(port instanceof MessagePort))throw new TypeError('A private delegate port is required');
  const owners=new Map();let closed=false,clientSequence=0;
  const close=()=>{
    if(closed)return;closed=true;port.removeEventListener('message',receive);
    for(const entry of owners.values())entry.controller.abort();owners.clear();
    try{port.postMessage({type:'closed'});}catch{}port.close();
  };
  const receive=async event=>{
    const message=event.data;if(message?.type==='closed'){close();return;}
    if(closed||message?.type!=='request'||!Number.isSafeInteger(message.id))return;
    let connected;
    try{
      let value,transfer=[];
      if(message.op==='owner'){
        if(typeof message.actor!=='string'||!message.actor)throw new TypeError('An actor identity is required');
        let entry=owners.get(message.actor);
        if(!entry){
          entry={controller:new AbortController(),profile:JSON.stringify(message.profile),clients:new Map()};owners.set(message.actor,entry);
          entry.ready=create({...message.profile,signal:entry.controller.signal}).then(owner=>{
            entry.owner=owner;
            owner.events.addEventListener('error',event=>{
              const client=entry.clients.get(event.data.client);
              if(!closed&&client!==undefined)port.postMessage({...event.data,type:'constructor-error',actor:message.actor,client});
            });
            owner.closed.then(()=>{if(owners.get(message.actor)===entry){owners.delete(message.actor);if(!closed)port.postMessage({type:'owner-closed',actor:message.actor});}});
            return owner;
          }).catch(error=>{if(owners.get(message.actor)===entry)owners.delete(message.actor);throw error;});
        }else if(entry.profile!==JSON.stringify(message.profile))throw new DOMException('Actor owner profile changed','InvalidStateError');
        await entry.ready;value=true;
      }else if(message.op==='connect'){
        const entry=owners.get(message.actor);if(!entry)throw new DOMException('Actor owner is unavailable','InvalidStateError');
        const owner=await entry.ready;connected=await owner.connect();const client=++clientSequence;entry.clients.set(connected.id,client);transfer=[connected.port];value={client};
      }else if(message.op==='close'){
        const entry=owners.get(message.actor);value=!!entry;
        if(entry){owners.delete(message.actor);entry.controller.abort();}
      }else throw new TypeError('Unknown actor delegate operation');
      if(closed){connected?.port.close();return;}
      port.postMessage({type:'reply',id:message.id,ok:true,value},transfer);
    }catch(error){connected?.port.close();if(!closed)try{port.postMessage({type:'reply',id:message.id,ok:false,error:{name:String(error.name||'Error'),message:String(error.message||error)}});}catch{}}
  };
  port.addEventListener('message',receive);port.start();return {close};
}

export async function delegate(){
  const lease=await hold_lock(delegate_prefix+create_bootstrap_nonce()),channel=new MessageChannel(),server=serve(channel.port1);let closed=false;
  return {port:channel.port2,lease:lease.name,close(){if(closed)return;closed=true;server.close();lease.close();}};
}
