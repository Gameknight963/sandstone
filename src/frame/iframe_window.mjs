import {ctx} from './context.mjs';
import {create_obj_proxy} from './global_functions.mjs';
import {register_message_peer,window_post_message} from './window_messages.mjs';

const frames=new WeakMap();
const windows=new WeakMap();
const descriptor=globalThis.HTMLIFrameElement&&Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'contentWindow');
export function native_frame_window(element){return descriptor?.get.call(element);}
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
      const same=!state.opaque()&&(!state.url()||new URL(state.url()).origin===ctx.location.origin);
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
    if(state.target===target)return state.window;
    state.target=target;
    const nativeLocation=()=>target.location;
    const readable=()=>{
      const url=state.url();
      // Runtime documents have opaque physical origins. Access checks must use
      // the virtual document, including the creator-origin initial blank page.
      if(state.opaque())throw new DOMException('Blocked access to a sandboxed frame','SecurityError');
      if(!url)return 'about:blank';
      if(new URL(url).origin!==ctx.location.origin)throw new DOMException('Blocked access to a cross-origin frame','SecurityError');
      return url;
    };
    const navigate=(value,mode)=>{
      const url=new URL(`${value}`,ctx.document.baseURI);
      if(url.protocol==='http:'||url.protocol==='https:')state.navigate(url.href,mode);
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
        if(['href','origin','protocol','host','hostname','port','pathname','search','hash'].includes(key))return new URL(url)[key];
        return Reflect.get(nativeLocation(),key,nativeLocation());
      },
      set(_,key,value){
        if(key==='href'){navigate(value,'push');return true;}
        const url=new URL(readable());
        if(['protocol','host','hostname','port','pathname','search','hash'].includes(key)){
          url[key]=`${value}`;navigate(url.href,'push');return true;
        }
        return Reflect.set(nativeLocation(),key,value,nativeLocation());
      }
    });
    const replacements=Object.create(null);
    Object.defineProperties(replacements,{
      postMessage:{value:(...args)=>window_post_message(target,state.token,args)},
      location:{get:()=>location,set:value=>{location.href=value;}},
      window:{get:()=>state.window},self:{get:()=>state.window},frames:{get:()=>state.window},
      parent:{get:()=>ctx.window},top:{get:()=>ctx.top}
    });
    state.window=create_obj_proxy(replacements,['location'],target);
    windows.set(target,state.window);
    register_message_peer(target,state.token,()=>state.window);
    return state.window;
  }
});

// Message sources and contentWindow refer to the same WindowProxy in browsers.
const source=globalThis.MessageEvent&&Object.getOwnPropertyDescriptor(MessageEvent.prototype,'source');
if(source)Object.defineProperty(MessageEvent.prototype,'source',{
  ...source,get(){const target=source.get.call(this);return windows.get(target)||target;}
});

export function intercept_iframe_window(element,url,navigate,token,{name=()=>'',opaque=()=>false}={}){
  frames.set(element,{url,navigate,token,name,opaque:()=>opaque()||element.hasAttribute('sandbox')&&!element.sandbox.contains('allow-same-origin')});
}
