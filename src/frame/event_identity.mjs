import {document_states,wrap_frame_document,unwrap_frame_document} from './document_identity.mjs';
import {configure_event_scope,authored_event_view,with_event_scope,event_target_alias} from '../event_scope.mjs';
import {unwrap_global_target} from './global_functions.mjs';

const windows=document_states('event-windows'),callbacks=document_states('event-callbacks');
const window_targets=document_states('event-window-targets');
const window_setters=document_states('event-window-setters'),window_fields=new Set();
let own_window_setters;
const properties=document_states('event-properties');
const current=globalThis.Event&&Object.getOwnPropertyDescriptor(Event.prototype,'currentTarget').get;
export const event_current_target=event=>current.call(event);
const kind=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'nodeType').get;
const owner=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'ownerDocument').get;
const add=globalThis.EventTarget?.prototype.addEventListener;
export function event_document(value){try{return kind.call(value)===9?value:owner.call(value);}catch{return undefined;}}
export function native_element(value){try{return kind.call(value)===1;}catch{return false;}}
export function configure_document_events(group,window){
  configure_event_scope(group.event_views??=new WeakMap());
  windows.set(globalThis,window);
  window_targets.set(window,globalThis);
  if(!own_window_setters){
    own_window_setters=new Map();
    for(const name of window_fields)own_window_setters.set(name,Object.getOwnPropertyDescriptor(globalThis,name)?.set);
  }
  window_setters.set(globalThis,own_window_setters);
}
export function set_window_event_handler(target,name,value,alias){
  const setter=window_setters.get(target)?.get(name),property=Object.getOwnPropertyDescriptor(target,name);
  if(setter&&property?.set===setter){
    // This descriptor belongs to the initialized runtime. Its receiver adapter
    // can retain a caller's stable contentWindow alias without invoking getters.
    window_targets.set(alias,target);
    return Reflect.set(target,name,value,alias);
  }
  return Reflect.set(target,name,value,target);
}
export function register_window_event_alias(alias,target){
  if(window_setters.has(target))window_targets.set(alias,target);
}
export function event_target(value,event){return (event&&event_target_alias(event,value))||windows.get(value)||wrap_frame_document(value);}
export function document_event_alias(target,alias){return target===event_document(target)?{target,alias}:undefined;}
export function native_event_target(value){
  // A null callback registers nothing and lets native Web IDL check the brand
  // without inspecting author properties or converting the real arguments.
  try{Reflect.apply(add,value,['',null]);return true;}catch{return false;}
}
export function event_callback(target,listener,create=true,alias=event_target(target)){
  if(!listener||!['function','object'].includes(typeof listener))return listener;
  let entries=callbacks.get(target);if(!entries){if(!create)return listener;callbacks.set(target,entries=new WeakMap());}
  let callback=entries.get(listener);
  if(!callback&&create){
    const view=document_event_alias(target,alias);
    callback=function(event){return with_event_scope(event,true,()=>typeof listener==='function'?Reflect.apply(listener,event_target(this,event),[event]):listener.handleEvent(event),view);};
    entries.set(listener,callback);
  }
  return callback||listener;
}
export function event_handler(listener,view){
  if(typeof listener!=='function')return listener;
  const callback=function(...args){return with_event_scope(args[0],true,()=>Reflect.apply(listener,event_target(this,args[0]),args),view);};
  properties.set(callback,listener);return callback;
}
export function event_handler_value(callback){
  // Forwarded body/window handlers can pass through more than one adapter.
  // Only follow wrappers registered by a native-accessible runtime.
  while(properties.has(callback))callback=properties.get(callback);
  return callback;
}
if(globalThis.Window&&globalThis.window===globalThis){
  for(const name of Object.getOwnPropertyNames(globalThis)){
    const property=Object.getOwnPropertyDescriptor(globalThis,name);
    if(!name.startsWith('on')||!property.get||!property.set||!property.configurable)continue;
    window_fields.add(name);
    const unwrap=value=>window_targets.get(value)||unwrap_global_target(value);
    Object.defineProperty(globalThis,name,{...property,
      get:new Proxy(property.get,{apply(target,receiver,args){return event_handler_value(Reflect.apply(target,unwrap(receiver),args));}}),
      set:new Proxy(property.set,{apply(target,receiver,args){
        const native=unwrap(receiver),converted=[...args],view=native!==receiver?{target:native,alias:receiver}:undefined;
        if(args.length)converted[0]=event_handler(args[0],view);
        return Reflect.apply(target,native,converted);
      }})
    });
  }
}
if(globalThis.Document){
  for(const name of Object.getOwnPropertyNames(Document.prototype)){
    const property=Object.getOwnPropertyDescriptor(Document.prototype,name);
    if(!name.startsWith('on')||!property.get||!property.set||!property.configurable)continue;
    Object.defineProperty(Document.prototype,name,{...property,
      get:new Proxy(property.get,{apply(target,receiver,args){return event_handler_value(Reflect.apply(target,unwrap_frame_document(receiver),args));}}),
      set:new Proxy(property.set,{apply(target,receiver,args){const native=unwrap_frame_document(receiver),converted=[...args];if(args.length)converted[0]=event_handler(args[0],document_event_alias(native,receiver));return Reflect.apply(target,native,converted);}})
    });
  }
}
if(globalThis.Event){
  for(const name of ['target','currentTarget','srcElement']){
    const property=Object.getOwnPropertyDescriptor(Event.prototype,name);if(!property?.get)continue;
    Object.defineProperty(Event.prototype,name,{...property,get:new Proxy(property.get,{apply(target,receiver,args){
      const value=Reflect.apply(target,receiver,args);return authored_event_view(receiver)?event_target(value,receiver):value;
    }})});
  }
  const path=Event.prototype.composedPath;
  Event.prototype.composedPath=new Proxy(path,{apply(target,receiver,args){const value=Reflect.apply(target,receiver,args);if(authored_event_view(receiver))for(let index=0;index<value.length;index++)value[index]=event_target(value[index],receiver);return value;}});
}
