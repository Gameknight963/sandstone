import {ctx,convert_url} from './context.mjs';
import * as loader from './loader.mjs';
import {window_runtime_context} from './runtime_context.mjs';
import {navigate_target} from './navigation_targets.mjs';
import {cookie_document_active} from './polyfill/cookie.mjs';

export function ancestor_location(target,depth,frame=()=>loader.frame_id,canNavigate){
  const readable=()=>{
    const context=window_runtime_context(target);
    if(!context||ctx.origin==='null'||context.origin!==ctx.origin)throw new DOMException('Blocked access to a cross-origin window','SecurityError');
    return context.location.href;
  };
  const navigate=(value,mode)=>{
    const text=`${value}`;
    if(!cookie_document_active(document))throw new DOMException('The source document is unavailable','SecurityError');
    if(canNavigate&&!canNavigate())throw new DOMException('Blocked navigation to an ancestor window','SecurityError');
    const base=ctx.document.baseURI;
    let url;try{url=convert_url(text,base,loader.character_encoding);}catch{throw new DOMException('Invalid navigation URL','SyntaxError');}
    if(target.closed)return;
    const context=window_runtime_context(target);
    if(mode!=='reload'&&context&&ctx.origin!=='null'&&context.origin===ctx.origin&&url.includes('#')&&url.split('#')[0]===context.location.href.split('#')[0]){
      target.sandstone_frame.navigate_fragment(url,mode==='replace');return;
    }
    // The host selects the virtual ancestor and enforces origin, sandbox and
    // activation rules. Never navigate the native sandbox or standalone host.
    const id=frame();if(typeof id!=='string')throw new DOMException('The target window is unavailable','SecurityError');
    navigate_target(url,{id,ancestor:depth},null,{history_mode:mode}).catch(console.error);
  };
  let location;
  const methods={
    assign(value){if(this!==location)throw new TypeError('Illegal invocation');if(!arguments.length)throw new TypeError('A URL is required');readable();navigate(value,'push');},
    replace(value){if(this!==location)throw new TypeError('Illegal invocation');if(!arguments.length)throw new TypeError('A URL is required');navigate(value,'replace');},
    reload(){
      if(this!==location)throw new TypeError('Illegal invocation');
      const url=readable();if(target.closed)return;
      // Native reload requires same-origin access, even when a sandbox forbids
      // navigating the ancestor to another URL. Run the target's own reload.
      const runtime=target.sandstone_frame;
      runtime.loader.navigate(runtime.loader.frame_id,url,true,null,{history_mode:'reload',scroll:[target.scrollX||0,target.scrollY||0]}).catch(console.error);
    },
    toString(){if(this!==location)throw new TypeError('Illegal invocation');return readable();}
  };
  location=new Proxy(Object.create(Location.prototype),{
    get(_,key){
      if(key==='replace')return methods.replace;
      const url=readable();
      if(key===Symbol.toPrimitive)return undefined;
      if(key===Symbol.toStringTag)return 'Location';
      if(Object.hasOwn(methods,key))return methods[key];
      if(key==='ancestorOrigins')return window_runtime_context(target).location.ancestorOrigins;
      if(key==='origin')return window_runtime_context(target).location.origin;
      if(['href','protocol','host','hostname','port','pathname','search','hash'].includes(key))return new URL(url)[key];
      return Reflect.get(Location.prototype,key,location);
    },
    set(_,key,value){
      if(key==='href'){navigate(value,'push');return true;}
      const url=new URL(readable()),old_hash=url.hash;
      if(['protocol','host','hostname','port','pathname','search','hash'].includes(key)){
        const input=`${value}`;url[key]=key==='hash'&&input===''?'#':input;
        if(key==='hash'&&url.hash===old_hash)return true;
        navigate(url.href,'push');return true;
      }
      return Reflect.set(_,key,value);
    }
  });
  return location;
}
