import {ctx} from './context.mjs';
import * as loader from './loader.mjs';
import {document_states} from './document_identity.mjs';
import {message_peer_window} from './window_messages.mjs';
import {location_window} from './iframe_window.mjs';
import {ancestor_location} from './ancestor_location.mjs';
import {window_runtime_context} from './runtime_context.mjs';

const views=document_states('location-views'),fallbacks=new WeakMap();
const native=globalThis.Location&&Object.getOwnPropertyDescriptors(globalThis.location);
const method_names=['assign','replace','reload','toString'];
function brand(receiver){const entry=views.get(receiver);if(!entry)throw new TypeError('Illegal invocation');return entry;}
function coerce(value){
  if(typeof value==='symbol')throw new TypeError('Cannot convert a Symbol to a string');
  // Keep this conversion observable even when a retired target cannot navigate.
  // A discarded template literal can be removed by production minification.
  Reflect.apply(String,undefined,[value]);
}
export function register_location(location,entry){views.set(location,entry);return location;}
export function share_location(location){const entry=views.get(location);if(entry){entry.retarget?.();views.set(location,entry);}}

function local_location(entry){
  const target=entry.window();
  if(target===globalThis)return ctx.location;
  const peer=message_peer_window(target)||location_window(target);
  if(peer)return peer.location;
  let location=fallbacks.get(target);if(location)return location;
  const runtime=()=>{try{return target.sandstone_frame;}catch{}};
  const allowed=()=>{
    const ancestors=[],seen=new Set();let window=target;
    while(window&&!seen.has(window)){
      if(window===globalThis)return true;
      seen.add(window);ancestors.push(window);
      if(window===window.parent)break;window=window.parent;
    }
    if(loader.navigation_sandbox.navigation)return false;
    return ctx.origin!=='null'&&ancestors.some(window=>window_runtime_context(window)?.origin===ctx.origin);
  };
  // Location can replace an active blank document before its storage snapshot
  // resolves. Host registration, not storage readiness, admits navigation.
  location=ancestor_location(target,0,()=>entry.frame?.()||runtime()?.loader.frame_id,allowed);
  fallbacks.set(target,location);return location;
}
function readable(entry){
  if(entry.window()===globalThis||ctx.origin!=='null'&&entry.origin()===ctx.origin)return entry.readable();
  const local=brand(local_location(entry));local.readable();return entry.readable();
}
function invoke(name,receiver,args){
  const entry=brand(receiver);
  if(name!=='replace')readable(entry);
  if(name==='toString')return entry.readable();
  if((name==='assign'||name==='replace')&&!args.length)throw new TypeError('A URL is required');
  if(entry.active&&!entry.active()){
    if(name!=='reload')coerce(args[0]);
    return;
  }
  return brand(local_location(entry)).invoke(name,args);
}
export function location_methods(){
  return Object.fromEntries(method_names.map(name=>[name,new Proxy(native[name].value,{apply:(_,receiver,args)=>invoke(name,receiver,args)})]));
}
export function create_location(entry){
  const target=Object.create(Location.prototype),location=new Proxy(target,{setPrototypeOf:(object,prototype)=>Reflect.getPrototypeOf(object)===prototype}),methods=location_methods();
  register_location(location,entry);
  for(const key of Reflect.ownKeys(native)){
    const descriptor={...native[key]};
    if(method_names.includes(key))descriptor.value=methods[key];
    else if(descriptor.get){
      descriptor.get=new Proxy(descriptor.get,{apply:(_,receiver)=>{const value=brand(receiver);readable(value);return value.get(key);}});
      if(descriptor.set)descriptor.set=new Proxy(descriptor.set,{apply:(_,receiver,args)=>{
        const value=brand(receiver);if(key!=='href')readable(value);
        if(!args.length)throw new TypeError('A value is required');
        if(value.active&&!value.active()){coerce(args[0]);return;}
        brand(local_location(value)).set(key,args[0]);
      }});
    }
    Object.defineProperty(target,key,descriptor);
  }
  return location;
}
