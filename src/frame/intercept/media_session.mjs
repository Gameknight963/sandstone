import {ctx} from '../context.mjs';
import * as network from '../network.mjs';
import {on_document_unload} from '../runtime_events.mjs';

const NativeMetadata=globalThis.MediaMetadata,NativeSession=globalThis.MediaSession;
if(NativeMetadata&&NativeSession){
  const artwork=Object.getOwnPropertyDescriptor(NativeMetadata.prototype,'artwork');
  const metadata=Object.getOwnPropertyDescriptor(NativeSession.prototype,'metadata');
  const states=new WeakMap(),urls=new Set(),pending=new Set();
  const apply=Reflect.apply,construct=Reflect.construct;
  const object=value=>value!==null&&(typeof value==='object'||typeof value==='function');
  // Let native Web IDL consume and validate each dictionary in iterator order.
  // Only resolve src against the virtual document instead of the sandbox URL.
  function images(value){
    if(!object(value))return value;
    return (function*(){for(const image of value)yield object(image)?new Proxy(image,{get(target,key){
      const value=Reflect.get(target,key,target);
      return key==='src'&&value!==undefined?new URL(`${value}`,ctx.document.baseURI).href:value;
    }}):image;})();
  }
  function initialize(value){return object(value)?new Proxy(value,{get(target,key){const value=Reflect.get(target,key,target);return key==='artwork'?images(value):value;}}):value;}
  function release(state){
    state.controller.abort();pending.delete(state);
    for(const url of state.urls){urls.delete(url);URL.revokeObjectURL(url);}
  }
  function remember(value,holder){
    const previous=states.get(value);if(previous)release(previous);
    // An unattached holder preserves native FrozenArray/dictionary reflection
    // without ever handing its remote URLs to the browser's media controls.
    const state={holder,controller:new AbortController(),urls:[],started:false};
    apply(artwork.set,value,[[]]);states.set(value,state);return state;
  }
  function start(value,state){
    if(state.started)return;state.started=true;pending.add(state);
    const {signal}=state.controller;
    Promise.all(apply(artwork.get,state.holder,[]).map(async image=>{
      if(/^(data|blob):/i.test(image.src))return image;
      if(!/^https?:/i.test(image.src))return null;
      try{
        const response=await network.fetch(image.src,{mode:'no-cors',credentials:'include',destination:'image',signal});
        if(!response.ok){await response.body?.cancel();return null;}
        const blob=await response.blob();signal.throwIfAborted();
        const url=URL.createObjectURL(blob);urls.add(url);state.urls.push(url);
        return {...image,src:url};
      }catch{return null;}
    })).then(images=>{
      if(!signal.aborted&&states.get(value)===state)apply(artwork.set,value,[images.filter(Boolean)]);
    }).catch(()=>{}).finally(()=>pending.delete(state));
  }
  Object.defineProperty(NativeMetadata.prototype,'artwork',{...artwork,
    get:new Proxy(artwork.get,{apply(target,receiver,args){const state=states.get(receiver);return apply(target,state?.holder||receiver,args);}}),
    set:new Proxy(artwork.set,{apply(target,receiver,args){
      if(!args.length)return apply(target,receiver,args);
      apply(artwork.get,receiver,[]); // Brand-check before converting artwork.
      const holder=new NativeMetadata({artwork:images(args[0])}),old=states.get(receiver);
      const state=remember(receiver,holder);if(old?.started)start(receiver,state);
    }})
  });
  const Metadata=new Proxy(NativeMetadata,{construct(target,args,newTarget){
    const value=construct(target,args.length?[initialize(args[0])]:args,newTarget);
    const holder=new NativeMetadata({artwork:apply(artwork.get,value,[])});
    remember(value,holder);return value;
  }});
  globalThis.MediaMetadata=Metadata;
  Object.defineProperty(NativeMetadata.prototype,'constructor',{...Object.getOwnPropertyDescriptor(NativeMetadata.prototype,'constructor'),value:Metadata});
  Object.defineProperty(NativeSession.prototype,'metadata',{...metadata,set:new Proxy(metadata.set,{apply(target,receiver,args){
    apply(metadata.get,receiver,[]);
    const value=args[0];let state;
    if(value!==null&&value!==undefined){
      state=states.get(value);
      if(!state){const holder=new NativeMetadata({artwork:apply(artwork.get,value,[])});state=remember(value,holder);}
    }
    const result=apply(target,receiver,args);if(state)start(value,state);return result;
  }})});
  on_document_unload(()=>{for(const state of pending)state.controller.abort();pending.clear();for(const url of urls)URL.revokeObjectURL(url);urls.clear();});
}
