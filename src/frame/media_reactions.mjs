import {is_internal_attribute_mutation} from './intercept/mutation_observer.mjs';

const registry=globalThis.CustomElementRegistry?.prototype,media=globalThis.HTMLMediaElement?.prototype,iframe=globalThis.HTMLIFrameElement?.prototype;
const before_reactions=new WeakMap();
export function before_attribute_reaction(element,callback){
  const previous=before_reactions.get(element),invoke=()=>{previous?.();callback();};
  before_reactions.set(element,invoke);
  return ()=>{if(before_reactions.get(element)!==invoke)return;if(previous)before_reactions.set(element,previous);else before_reactions.delete(element);};
}
const descriptor=Object.getOwnPropertyDescriptor,define=Object.defineProperty,prototype=Object.getPrototypeOf;
const inherited=(object,key)=>{for(let current=object;current;current=prototype(current)){const value=descriptor(current,key);if(value)return value;}};
if(registry&&(media||iframe)){
  const native=registry.define;
  registry.define=new Proxy(native,{apply(target,receiver,args){
    const constructor=args[1],entry=typeof constructor==='function'&&descriptor(constructor,'prototype'),object=entry?.value;
    // Leave conversion-sensitive definitions to the browser. Ordinary media/frame
    // subclasses can cache a reaction wrapper without replacing their public
    // constructor, prototype, or authored callback.
    const options=args[2],extendsEntry=options&&typeof options==='object'&&descriptor(options,'extends');
    if(typeof args[0]!=='string'||!object||!extendsEntry||!('value' in extendsEntry)||!(media&&Object.prototype.isPrototypeOf.call(media,object)||iframe&&extendsEntry.value==='iframe'&&Object.prototype.isPrototypeOf.call(iframe,object)))return Reflect.apply(target,receiver,args);
    const own=descriptor(object,'attributeChangedCallback'),callback=inherited(object,'attributeChangedCallback');
    if(!callback||own&&!own.configurable||!own&&!Object.isExtensible(object))return Reflect.apply(target,receiver,args);
    for(const key of ['connectedCallback','disconnectedCallback','adoptedCallback','connectedMoveCallback']){
      const value=inherited(object,key);if(value&&!('value' in value))return Reflect.apply(target,receiver,args);
    }
    let restored=false;
    const restore=()=>{if(restored)return;restored=true;if(own)define(object,'attributeChangedCallback',own);else delete object.attributeChangedCallback;};
    define(object,'attributeChangedCallback',{configurable:true,enumerable:own?.enumerable||false,get(){
      restore();const value='value' in callback?callback.value:callback.get?.call(this);
      return typeof value==='function'?new Proxy(value,{apply(method,element,argumentsList){
        if(is_internal_attribute_mutation(element,argumentsList[0]))return;
        before_reactions.get(element)?.();
        return Reflect.apply(method,element,argumentsList);
      }}):value;
    }});
    try{return Reflect.apply(target,receiver,args);}finally{restore();}
  }});
}
