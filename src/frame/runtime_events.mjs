import {with_event_scope} from '../event_scope.mjs';

const native_events={add:EventTarget.prototype.addEventListener,remove:EventTarget.prototype.removeEventListener};
const apply=Reflect.apply;
const stop_message=Event.prototype.stopImmediatePropagation;
const window_post=globalThis.Window&&globalThis.postMessage,worker_post=globalThis.Worker?.prototype.postMessage;
const message_fields=Object.fromEntries(['data','source','ports'].map(key=>[key,globalThis.MessageEvent&&Object.getOwnPropertyDescriptor(MessageEvent.prototype,key)?.get]));
export function runtime_message(event,key){try{return apply(message_fields[key],event,[]);}catch{return event[key];}}
export const stop_runtime_message=event=>apply(stop_message,event,[]);
export function post_bootstrap_message(target,message,ports=[],worker=false){
  return apply((worker?worker_post:window_post)||target.postMessage,target,[message,{targetOrigin:'*',transfer:ports}]);
}

// document.open removes native listeners. Keep only runtime registrations so
// restoring the relay never restores the page's own discarded listeners.
const targets=new WeakMap();
const capture=options=>typeof options==='object'&&options!==null?!!options.capture:!!options;
const add=(target,...args)=>Reflect.apply(target instanceof EventTarget?native_events.add:target.addEventListener,target,args);
const remove=(target,...args)=>Reflect.apply(target instanceof EventTarget?native_events.remove:target.removeEventListener,target,args);
export function listen_runtime(target,type,listener,options){
  let entries=targets.get(target);if(!entries){entries=[];targets.set(target,entries);}
  const capturing=capture(options);
  if(entries.some(entry=>entry.type===type&&entry.listener===listener&&entry.capture===capturing))return;
  const entry={type,listener,options,capture:capturing,active:true};
  entry.callback=function(event){
    if(options?.once)forget(target,entry);
    return with_event_scope(event,false,()=>typeof listener==='function'?listener.call(this,event):listener.handleEvent(event));
  };
  add(target,type,entry.callback,options);
  if(options?.signal?.aborted)return;
  entries.push(entry);
  if(options?.signal){entry.aborted=()=>forget(target,entry);add(options.signal,'abort',entry.aborted,{once:true});}
}
function forget(target,entry){
  entry.active=false;const entries=targets.get(target),index=entries?.indexOf(entry);if(index>=0)entries.splice(index,1);
  if(entry.aborted)remove(entry.options.signal,'abort',entry.aborted);
}
export function unlisten_runtime(target,type,listener,options){
  const entry=targets.get(target)?.find(entry=>entry.type===type&&entry.listener===listener&&entry.capture===capture(options));
  if(!entry)return remove(target,type,listener,options);
  forget(target,entry);remove(target,type,entry.callback,entry.capture);
}
export function on_document_unload(listener,target=globalThis){
  const remove=()=>unlisten_runtime(target,'unload',unload);
  const unload=function(event){
    // Synthetic lifecycle events still reach page handlers. They must neither
    // release document resources nor consume the eventual native teardown hook.
    if(!event.isTrusted)return;
    remove();return Reflect.apply(listener,this,[event]);
  };
  listen_runtime(target,'unload',unload);
  return remove;
}
export function snapshot_runtime_events(nodes){
  return [...nodes].map(target=>({target,entries:[...targets.get(target)||[]]}));
}
export function restore_runtime_events(snapshot){
  for(const {target,entries} of snapshot)for(const entry of entries)if(entry.active)add(target,entry.type,entry.callback,entry.options);
}
