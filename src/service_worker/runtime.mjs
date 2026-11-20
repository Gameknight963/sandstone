import {create_service_worker_events} from './events.mjs';
import {create_service_worker_dispatcher} from './dispatcher.mjs';
import {response_metadata} from '../response_metadata.mjs';
import {remember_request,request_metadata} from '../request_metadata.mjs';
import {create_worker_clients} from './worker_clients.mjs';

// The owner supplies this private transport. Pages never receive the control
// port: authored postMessage traffic is delivered as ExtendableMessageEvent.
export function create_service_worker_runtime({profile,target=globalThis,send,scripts=()=>[],Request:RequestClass=globalThis.Request,requestMetadata=request_metadata,responseMetadata=response_metadata,encode=value=>value}){
  const peers=create_worker_clients({command,base:profile.scriptURL,encode});
  const events=create_service_worker_events({requestMetadata,responseMetadata,sourceValid:peers.valid});
  const jobs=new Map(),readers=new Map(),commands=new Map(),queued=[];
  const collect=id=>{const job=jobs.get(id);if(job?.complete&&(!job.fetch||job.handled&&!readers.has(id)))jobs.delete(id);};
  let ready=false,closed=false,nextCommand=0;
  const error_value=error=>({name:error?.name||'Error',message:error?.message||String(error),...(typeof error?.stack==='string'?{stack:error.stack}:{})});
  const reply=(id,type,value={})=>{if(!closed)send({id,type,...value});};
  const fail=(id,error)=>reply(id,'error',{error:error_value(error)});
  const dispatcher=create_service_worker_dispatcher({events,target,nativeTarget:globalThis});
  function command(method,args=[],ports=[]){
    if(closed)return Promise.reject(new DOMException('Service worker was terminated','AbortError'));
    const id=++nextCommand;
    return new Promise((resolve,reject)=>{commands.set(id,{resolve,reject});try{send({type:'command',id,method,args,ports},ports);}catch(error){commands.delete(id);reject(error);}});
  }
  const registration=Object.create(null);
  const clients=peers.clients;
  for(const key of ['scope','updateViaCache'])Object.defineProperty(registration,key,{enumerable:true,get:()=>profile[key]});
  Object.defineProperties(registration,{
    update:{value:()=>command('registration.update').then(()=>registration),enumerable:true},
    unregister:{value:()=>command('registration.unregister'),enumerable:true},
    [Symbol.toStringTag]:{value:'ServiceWorkerRegistration'}
  });
  async function dispatch(packet){
    let event,controller;
    if(packet.event==='fetch'){
      const {url,body,destination,virtualReferrer,aborted,context,...init}=packet.request;
      controller=new AbortController();if(aborted)controller.abort();
      const request=remember_request(new RequestClass(url,{...init,mode:init.mode==='navigate'?'same-origin':init.mode,referrer:virtualReferrer||'',signal:controller.signal,...(body===undefined?{}:{body})}),{context,mode:init.mode,redirect:init.redirect,destination:destination||'',referrer:virtualReferrer||''});
      event=new events.FetchEvent('fetch',{request,clientId:packet.clientId||'',resultingClientId:packet.resultingClientId||'',cancelable:true});
    }else if(packet.event==='message'||packet.event==='messageerror'){
      event=new events.ExtendableMessageEvent(packet.event,{data:packet.data,origin:packet.origin,ports:packet.ports||[],source:peers.source(packet.source)});
    }else if(packet.event==='install'||packet.event==='activate')event=new events.ExtendableEvent(packet.event);
    else throw new TypeError('Unsupported service worker event');
    if(jobs.has(packet.id)||readers.has(packet.id))throw new TypeError('Duplicate service worker event ID');
    const job={event,controller,fetch:packet.event==='fetch'};jobs.set(packet.id,job);
    const result=await dispatcher.deliver(event);
    result.lifetime.then(()=>reply(packet.id,'lifetime'),error=>reply(packet.id,'lifetime',{error:error_value(error)})).finally(()=>{job.complete=true;collect(packet.id);});
    await result.dispatched;
    if(!job.fetch){reply(packet.id,'dispatched');return;}
    if(!result.responded){reply(packet.id,'fallback');return;}
    try{
      const handle=await result.response;
      if(closed||job.canceled){await handle.reader?.cancel();if(!closed)fail(packet.id,new DOMException('Request was aborted','AbortError'));return;}
      if(handle.reader)readers.set(packet.id,handle.reader);
      reply(packet.id,'response',{metadata:{...handle.metadata,headers:[...handle.metadata.headers]},body:!!handle.reader});
    }catch(error){fail(packet.id,error);}
  }
  async function receive(packet){
    if(closed)return;
    if(!packet||typeof packet!=='object')return;
    if(packet.type==='command-result'){
      const pending=commands.get(packet.id);if(!pending)return;commands.delete(packet.id);
      if(packet.error)pending.reject(Object.assign(new Error(packet.error.message),{name:packet.error.name}));else pending.resolve(packet.value);
      return;
    }
    if(!ready){queued.push(packet);return;}
    try{
      if(packet.type==='scripts'){reply(packet.id,'scripts',{scripts:scripts()});return;}
      if(packet.type==='dispatch'){await dispatch(packet);return;}
      if(packet.type==='abort'){jobs.get(packet.id)?.controller?.abort(packet.reason);return;}
      if(packet.type==='handled'){
        const job=jobs.get(packet.id);if(!job?.fetch)return;
        if(packet.error)events.finish_fetch(job.event,Object.assign(new Error(packet.error.message),{name:packet.error.name}));else events.finish_fetch(job.event);
        job.handled=true;collect(packet.id);return;
      }
      if(packet.type==='read'){
        const reader=readers.get(packet.id);if(!reader)throw new TypeError('Unknown service worker response body');
        let result;
        try{result=await reader.read();}
        catch(error){readers.delete(packet.id);collect(packet.id);try{await reader.cancel(error);}catch{}throw error;}
        if(result.done){readers.delete(packet.id);collect(packet.id);}
        reply(packet.id,'chunk',result);return;
      }
      if(packet.type==='cancel'){
        const job=jobs.get(packet.id);if(job)job.canceled=true;
        const reader=readers.get(packet.id);readers.delete(packet.id);collect(packet.id);if(reader)await reader.cancel(packet.reason);
        reply(packet.id,'canceled');return;
      }
      throw new TypeError('Unknown service worker control message');
    }catch(error){fail(packet.id,error);}
  }
  function start(){if(ready||closed)return;ready=true;send({type:'ready'});for(const packet of queued.splice(0))void receive(packet);}
  function destroy(reason=new DOMException('Service worker was terminated','AbortError')){
    if(closed)return;closed=true;dispatcher.destroy(reason);
    for(const reader of readers.values())reader.cancel(reason).catch(()=>{});readers.clear();
    for(const pending of commands.values())pending.reject(reason);commands.clear();queued.length=0;jobs.clear();
  }
  return {events,dispatcher,registration,clients,Client:peers.Client,WindowClient:peers.WindowClient,skipWaiting:()=>command('skipWaiting'),receive,start,destroy};
}

export function install_service_worker_globals(runtime,{target=globalThis,names=[]}={}){
  const native=globalThis,prototype=EventTarget.prototype;
  const originals=Object.fromEntries(['addEventListener','removeEventListener','dispatchEvent'].map(key=>[key,Object.getOwnPropertyDescriptor(prototype,key)]));
  for(const key of Object.keys(originals)){
    const original=originals[key].value;
    Object.defineProperty(prototype,key,{...originals[key],value:function(...args){
      if(this===native||this===target)return runtime.dispatcher[key](...args);
      return Reflect.apply(original,this,args);
    }});
  }
  const values={...runtime.events,Client:runtime.Client,WindowClient:runtime.WindowClient,registration:runtime.registration,clients:runtime.clients,skipWaiting:runtime.skipWaiting,
    addEventListener:runtime.dispatcher.addEventListener,removeEventListener:runtime.dispatcher.removeEventListener,dispatchEvent:runtime.dispatcher.dispatchEvent};
  for(const key of ['adopt','dispatch_event','finish_fetch','expire','view','wrap_listener','untrust','listener_options'])delete values[key];
  for(const [key,value] of Object.entries(values)){
    Object.defineProperty(native,key,{value,writable:true,configurable:true,enumerable:true});if(!names.includes(key))names.push(key);
  }
  for(const type of ['install','activate','fetch','message','messageerror']){
    let handler=null,attached=false;
    const callback=event=>{if(handler&&Reflect.apply(handler,target,[event])===false)event.preventDefault();};
    Object.defineProperty(native,'on'+type,{configurable:true,enumerable:true,get:()=>handler,set(value){
      handler=typeof value==='function'?value:null;
      if(handler&&!attached){runtime.dispatcher.addEventListener(type,callback);attached=true;}
      else if(!handler&&attached){runtime.dispatcher.removeEventListener(type,callback);attached=false;}
    }});
    if(!names.includes('on'+type))names.push('on'+type);
  }
}
