import {is_internal_attribute_mutation} from './intercept/mutation_observer.mjs';

const registry=globalThis.CustomElementRegistry?.prototype,media=globalThis.HTMLMediaElement?.prototype;
const descriptor=Object.getOwnPropertyDescriptor,define=Object.defineProperty,prototype=Object.getPrototypeOf;
const inherited=(object,key)=>{for(let current=object;current;current=prototype(current)){const value=descriptor(current,key);if(value)return value;}};
if(registry&&media){
  const native=registry.define;
  registry.define=new Proxy(native,{apply(target,receiver,args){
    const constructor=args[1],entry=typeof constructor==='function'&&descriptor(constructor,'prototype'),object=entry?.value;
    // Leave conversion-sensitive definitions to the browser. Ordinary media
    // subclasses can cache a reaction wrapper without replacing their public
    // constructor, prototype, or authored callback.
    const options=args[2],extendsEntry=options&&typeof options==='object'&&descriptor(options,'extends');
    if(typeof args[0]!=='string'||!object||!Object.prototype.isPrototypeOf.call(media,object)||!extendsEntry||!('value' in extendsEntry))return Reflect.apply(target,receiver,args);
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
        return Reflect.apply(method,element,argumentsList);
      }}):value;
    }});
    try{return Reflect.apply(target,receiver,args);}finally{restore();}
  }});
}
