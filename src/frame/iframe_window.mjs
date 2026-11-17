import {ctx} from './context.mjs';
import {create_obj_proxy} from './global_functions.mjs';

const frames=new WeakMap();
const windows=new WeakMap();
const descriptor=globalThis.HTMLIFrameElement&&Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'contentWindow');
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
      location:{get:()=>location,set:value=>{location.href=value;}},
      window:{get:()=>state.window},self:{get:()=>state.window},frames:{get:()=>state.window},
      parent:{get:()=>ctx.window},top:{get:()=>ctx.top}
    });
    state.window=create_obj_proxy(replacements,['location'],target);
    windows.set(target,state.window);
    return state.window;
  }
});

// Message sources and contentWindow refer to the same WindowProxy in browsers.
const source=globalThis.MessageEvent&&Object.getOwnPropertyDescriptor(MessageEvent.prototype,'source');
if(source)Object.defineProperty(MessageEvent.prototype,'source',{
  ...source,get(){const target=source.get.call(this);return windows.get(target)||target;}
});

export function intercept_iframe_window(element,url,navigate){
  frames.set(element,{url,navigate,opaque:()=>element.hasAttribute('sandbox')&&!element.sandbox.contains('allow-same-origin')});
}
