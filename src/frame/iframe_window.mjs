import {window_runtime_context,window_runtime_value,window_runtime_accessor} from './runtime_context.mjs';
import {ctx,convert_url} from './context.mjs';
import {character_encoding} from './loader.mjs';
import {create_obj_proxy} from './global_functions.mjs';
import {register_message_peer,window_post_message} from './window_messages.mjs';
import {window_open_value,set_window_open} from './intercept/open.mjs';
import {sandbox_tokens} from '../navigation_policy.mjs';
import {set_window_event_handler,register_window_event_alias} from './event_identity.mjs';

const frames=new WeakMap();
const windows=new WeakMap();
const window_states=new WeakMap();
export function frame_window_state(target){return window_states.get(target);}
const descriptor=globalThis.HTMLIFrameElement&&Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'contentWindow');
const document_descriptor=globalThis.HTMLIFrameElement&&Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'contentDocument');
const context_value=window_runtime_value;
if(document_descriptor)Object.defineProperty(HTMLIFrameElement.prototype,'contentDocument',{...document_descriptor,get(){
  const value=document_descriptor.get.call(this),state=frames.get(this);if(!value||!state)return value;
  state.prepare?.(descriptor.get.call(this));
  if(!state.url()||state.opaque()||state.origin()!==ctx.origin)return null;
  try{if(!window_runtime_context(descriptor.get.call(this)))return null;}catch{return null;}
  return context_value(descriptor.get.call(this),'document');
}});
export function native_frame_window(element){return descriptor?.get.call(element);}
export function find_frame_target(name,parent){
  const elements=[...document.querySelectorAll('iframe')];
  for(let index=0;index<globalThis.length;index++){
    const target=globalThis[index],element=elements.find(element=>descriptor.get.call(element)===target),state=element&&frames.get(element);
    if(state?.name()===name)return {id:state.id,parent};
  }
  return null;
}
export function navigate_frame_target(id,url,form_data,navigation){
  for(const element of document.querySelectorAll('iframe')){
    const state=frames.get(element);
    if(state?.id===id)return state.navigate(url,'push',form_data,navigation);
  }
}
function window_index(key){
  const index=Number(key);
  return Number.isInteger(index)&&index>=0&&index<2**32-1&&String(index)===key;
}
export function virtual_frame_window(value,key){
  if(!descriptor)return value;
  const named=typeof key==='string'&&!window_index(key)&&!Object.hasOwn(globalThis,key)&&(value===undefined||value&&typeof value==='object');
  if(named){
    const elements=[...document.querySelectorAll('iframe')];
    // Native indexed order can differ from DOM order after insertion. Apply
    // virtual origin admission in that order, including duplicate frame names.
    for(let index=0;index<globalThis.length;index++){
      const target=globalThis[index],element=elements.find(element=>descriptor.get.call(element)===target),state=element&&frames.get(element);
      if(state?.name()!==key)continue;
      const same=!state.opaque()&&(!state.url()||state.origin()===ctx.origin);
      if(same||element.name===key)return element.contentWindow;
    }
    if(elements.some(element=>frames.has(element)&&descriptor.get.call(element)===value))return undefined;
  }
  const known=windows.get(value);
  if(known)return known;
  if(!value||typeof value!=='object')return value;
  // A newly inserted frame can be addressed by index or name before anyone has
  // read contentWindow. Let the browser select the named/indexed value, then
  // resolve its existing element adapter without reimplementing name lookup.
  for(const element of document.querySelectorAll('iframe')){
    if(descriptor.get.call(element)===value)return element.contentWindow;
  }
  return value;
}
if(descriptor)Object.defineProperty(HTMLIFrameElement.prototype,'contentWindow',{
  ...descriptor,
  get(){
    const target=descriptor.get.call(this),state=frames.get(this);
    if(!target||!state)return target;
    state.prepare?.(target);
    if(state.target===target){
      if(!state.opaque()&&(!state.url()||state.origin()===ctx.origin))register_window_event_alias(state.window,target);
      return state.window;
    }
    state.target=target;
    const nativeLocation=()=>target.location;
    const readable=()=>{
      const url=state.url();
      // Runtime documents have opaque physical origins. Access checks must use
      // the virtual document, including the creator-origin initial blank page.
      if(state.opaque())throw new DOMException('Blocked access to a sandboxed frame','SecurityError');
      if(!url)return 'about:blank';
      if(state.origin()!==ctx.origin)throw new DOMException('Blocked access to a cross-origin frame','SecurityError');
      // Same-document History changes are synchronous in the child. Its host
      // URL notification arrives later, so prefer the accessible live view.
      const context=window_runtime_context(target);
      if(context)return context.location.href;
      return url;
    };
    const navigate=(value,mode,fragment=false)=>{
      const url=new URL(convert_url(`${value}`,ctx.document.baseURI,character_encoding));
      const context=window_runtime_context(target);
      // Location changes between same-origin Windows are synchronous. Use the
      // child's private history controller so author overrides cannot replace it.
      if(context&&!state.opaque()&&state.origin()===ctx.origin&&(fragment||url.href.includes('#'))&&url.href.split('#')[0]===context.location.href.split('#')[0]){
        target.sandstone_frame.navigate_fragment(url.href,mode==='replace');return;
      }
      if(['http:','https:','blob:','data:','javascript:'].includes(url.protocol)||url.protocol==='about:'&&url.pathname==='srcdoc')state.navigate(url.href,mode,null,{fragment})?.catch(console.error);
      else if(mode==='replace')nativeLocation().replace(url.href);
      else nativeLocation().href=url.href;
    };
    let location;
    const methods={
      assign(value){if(this!==location)throw new TypeError('Illegal invocation');if(!arguments.length)throw new TypeError('A URL is required');readable();navigate(value,'push');},
      replace(value){if(this!==location)throw new TypeError('Illegal invocation');if(!arguments.length)throw new TypeError('A URL is required');navigate(value,'replace');},
      reload(){if(this!==location)throw new TypeError('Illegal invocation');state.navigate(readable(),'reload');},
      toString(){if(this!==location)throw new TypeError('Illegal invocation');return readable();}
    };
    location=new Proxy(Object.create(Location.prototype),{
      get(_,key){
        if(key==='replace')return methods.replace;
        const url=readable();
        if(key===Symbol.toPrimitive)return undefined;
        if(key===Symbol.toStringTag)return 'Location';
        if(Object.hasOwn(methods,key))return methods[key];
        if(key==='origin'){
          const context=window_runtime_context(target);if(context)return context.location.origin;
        }
        if(['href','origin','protocol','host','hostname','port','pathname','search','hash'].includes(key))return new URL(url)[key];
        return Reflect.get(nativeLocation(),key,nativeLocation());
      },
      set(_,key,value){
        if(key==='href'){navigate(value,'push');return true;}
        const before=readable(),url=new URL(before),old_hash=url.hash;
        if(['protocol','host','hostname','port','pathname','search','hash'].includes(key)){
          const input=`${value}`;url[key]=key==='hash'&&input===''?'#':input;
          if(key==='hash'&&url.hash===old_hash)return true;
          navigate(url.href,'push',key==='hash');return true;
        }
        return Reflect.set(nativeLocation(),key,value,nativeLocation());
      }
    });
    const replacements=Object.create(null);
    Object.defineProperties(replacements,{
      open:{get(){
        readable();
        return window_open_value(target,state.window,state);
      }},
      document:{get(){
        readable();
        // Initial blank documents have not installed resource interception.
        // Keep them unavailable until their runtime is prepared; exposing raw
        // documents here would let ordinary iframe writers bypass the relay.
        if(!state.url()||!window_runtime_context(target))throw new DOMException('The frame runtime is not ready','SecurityError');
        return context_value(target,'document');
      }},
      postMessage:{value:(...args)=>window_post_message(target,state.token,args)},
      location:{get:()=>location,set:value=>{location.href=value;}},
      window:{get:()=>state.window},self:{get:()=>state.window},frames:{get:()=>state.window},
      parent:{get:()=>ctx.window},top:{get:()=>ctx.top}
    });
    state.window=create_obj_proxy(replacements,['location'],target,undefined,key=>context_value(target,key),(key,value,alias)=>{
      if(typeof key==='string'&&key.startsWith('on')){readable();return set_window_event_handler(target,key,value,alias);}
      if(key==='open'){readable();return set_window_open(target,value,state);}
      return Reflect.set(target,key,value,target);
    },{virtual_accessors:true,read_accessor:key=>window_runtime_accessor(target,key)});
    if(!state.opaque()&&(!state.url()||state.origin()===ctx.origin))register_window_event_alias(state.window,target);
    windows.set(target,state.window);
    window_states.set(target,state);
    register_message_peer(target,state.token,()=>state.window);
    return state.window;
  }
});
const frame_window_getter=descriptor&&Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'contentWindow').get;
export function iframe_window(element){return frame_window_getter?.call(element);}

// Message sources and contentWindow refer to the same WindowProxy in browsers.
const source=globalThis.MessageEvent&&Object.getOwnPropertyDescriptor(MessageEvent.prototype,'source');
if(source)Object.defineProperty(MessageEvent.prototype,'source',{
  ...source,get(){const target=source.get.call(this);return windows.get(target)||target;}
});

export function intercept_iframe_window(element,url,navigate,token,{id,name=()=>'',opaque=()=>false,origin=()=>new URL(url()).origin,prepare}={}){
  frames.set(element,{id,url,navigate,token,name,origin,prepare,opaque:()=>opaque()||!url()&&element.hasAttribute('sandbox')&&!sandbox_tokens(element.getAttribute('sandbox')).has('allow-same-origin')});
}
