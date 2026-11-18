import {document_states,wrap_frame_document,unwrap_frame_document} from './document_identity.mjs';
import {configure_event_scope,authored_event_view,with_event_scope,event_target_alias} from '../event_scope.mjs';

const windows=document_states('event-windows'),callbacks=document_states('event-callbacks');
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
export const event_handler_value=callback=>properties.get(callback)||callback;
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
