import {create_service_worker_events} from './events.mjs';
import {create_service_worker_dispatcher} from './dispatcher.mjs';

// The owner supplies this private transport. Pages never receive the control
// port: authored postMessage traffic is delivered as ExtendableMessageEvent.
export function create_service_worker_runtime({profile,target=globalThis,send,scripts=()=>[],requestMetadata,responseMetadata}){
  const events=create_service_worker_events({requestMetadata,responseMetadata});
  const jobs=new Map(),readers=new Map(),commands=new Map(),queued=[];
  let ready=false,closed=false,nextCommand=0;
  const error_value=error=>({name:error?.name||'Error',message:error?.message||String(error),...(typeof error?.stack==='string'?{stack:error.stack}:{})});
  const reply=(id,type,value={})=>{if(!closed)send({id,type,...value});};
  const fail=(id,error)=>reply(id,'error',{error:error_value(error)});
  const dispatcher=create_service_worker_dispatcher({events,target,nativeTarget:globalThis});
  function command(method,args=[]){
    if(closed)return Promise.reject(new DOMException('Service worker was terminated','AbortError'));
    const id=++nextCommand;
    return new Promise((resolve,reject)=>{commands.set(id,{resolve,reject});try{send({type:'command',id,method,args});}catch(error){commands.delete(id);reject(error);}});
  }
  const registration=Object.create(null);
  for(const key of ['scope','updateViaCache'])Object.defineProperty(registration,key,{enumerable:true,get:()=>profile[key]});
  Object.defineProperties(registration,{
    update:{value:()=>command('registration.update'),enumerable:true},
    unregister:{value:()=>command('registration.unregister'),enumerable:true},
    [Symbol.toStringTag]:{value:'ServiceWorkerRegistration'}
  });
  async function dispatch(packet){
    let event;
    if(packet.event==='fetch'){
      const {url,body,...init}=packet.request;
      const request=new Request(url,{...init,...(body===undefined?{}:{body})});
      event=new events.FetchEvent('fetch',{request,clientId:packet.clientId||'',resultingClientId:packet.resultingClientId||'',cancelable:true});
    }else if(packet.event==='message'||packet.event==='messageerror'){
      event=new events.ExtendableMessageEvent(packet.event,{data:packet.data,origin:packet.origin,ports:packet.ports||[]});
    }else if(packet.event==='install'||packet.event==='activate')event=new events.ExtendableEvent(packet.event);
    else throw new TypeError('Unsupported service worker event');
    if(jobs.has(packet.id)||readers.has(packet.id))throw new TypeError('Duplicate service worker event ID');
    const job={event,fetch:packet.event==='fetch'};jobs.set(packet.id,job);
    const result=await dispatcher.deliver(event);
    result.lifetime.then(()=>reply(packet.id,'lifetime'),error=>reply(packet.id,'lifetime',{error:error_value(error)})).finally(()=>{job.complete=true;if(!job.fetch||job.handled)jobs.delete(packet.id);});
    await result.dispatched;
    if(!job.fetch){reply(packet.id,'dispatched');return;}
    if(!result.responded){reply(packet.id,'fallback');return;}
    try{
      const handle=await result.response;
      if(closed)return;
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
      if(packet.type==='handled'){
        const job=jobs.get(packet.id);if(!job?.fetch)return;
        if(packet.error)events.finish_fetch(job.event,Object.assign(new Error(packet.error.message),{name:packet.error.name}));else events.finish_fetch(job.event);
        job.handled=true;if(job.complete)jobs.delete(packet.id);return;
      }
      if(packet.type==='read'){
        const reader=readers.get(packet.id);if(!reader)throw new TypeError('Unknown service worker response body');
        const result=await reader.read();if(result.done)readers.delete(packet.id);
        reply(packet.id,'chunk',result);return;
      }
      if(packet.type==='cancel'){
        const reader=readers.get(packet.id);readers.delete(packet.id);if(reader)await reader.cancel(packet.reason);
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
  return {events,dispatcher,registration,skipWaiting:()=>command('skipWaiting'),receive,start,destroy};
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
  const values={...runtime.events,registration:runtime.registration,skipWaiting:runtime.skipWaiting,
    addEventListener:runtime.dispatcher.addEventListener,removeEventListener:runtime.dispatcher.removeEventListener,dispatchEvent:runtime.dispatcher.dispatchEvent};
  for(const key of ['dispatch_event','finish_fetch','expire','view','wrap_listener','untrust','listener_options'])delete values[key];
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
