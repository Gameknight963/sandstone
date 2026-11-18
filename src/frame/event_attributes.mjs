import {run_script} from './context.mjs';
import {finish_event_listener} from './link_events.mjs';
import {is_inert_node} from './dom_operations.mjs';
import {listen_runtime} from './runtime_events.mjs';
import * as loader from './loader.mjs';

const states=new WeakMap(),supported=new Set(),nativeHandlers=new WeakMap();
let assigning=0;
const attributes=globalThis.Element&&Object.getOwnPropertyDescriptor(Element.prototype,'attributes').get;
const attrValue=globalThis.Attr&&Object.getOwnPropertyDescriptor(Attr.prototype,'value').get;
function entries(element){let value=states.get(element);if(!value){value=new Map();states.set(element,value);}return value;}
export function rewrite_event_attributes(element){
  if(!(element instanceof Element)||is_inert_node(element))return;
  const handlers=entries(element);
  for(const attribute of attributes.call(element)){
    const name=attribute.name;
    if(attribute.namespaceURI!==null||!supported.has(name))continue;
    const source=attrValue.call(attribute);
    if(handlers.get(name)?.source===source)continue;
    let compiled;
    const handler=function(...args){
      if(loader.site_settings.allow_js===false)return;
      const parameters=name==='onerror'&&(element instanceof HTMLBodyElement||element instanceof HTMLFrameSetElement)?'event,source,lineno,colno,error':'event';
      compiled ||= run_script('(function('+parameters+'){\n'+source+'\n})');
      try{
        const result=compiled.apply(this,args);
        // Virtual default actions mask their own physical cancellation.
        if((name==='onclick'||name==='onsubmit')&&result===false)args[0]?.preventDefault();
        return result;
      }finally{finish_event_listener(args[0]);}
    };
    assigning++;
    try{
      for(let owner=Object.getPrototypeOf(element);owner;owner=Object.getPrototypeOf(owner)){
        const setter=nativeHandlers.get(owner)?.get(name);
        if(setter){setter.call(element,handler);break;}
      }
    }finally{assigning--;}
    handlers.set(name,{source,handler});
  }
}

if(globalThis.Element){
  const getAttribute=Element.prototype.getAttribute;
  const namespace=Object.getOwnPropertyDescriptor(Element.prototype,'namespaceURI').get;
  const ownerDocument=Object.getOwnPropertyDescriptor(Node.prototype,'ownerDocument').get;
  const contentType=Object.getOwnPropertyDescriptor(Document.prototype,'contentType').get;
  const visited=new WeakMap();
  for(const Constructor of [globalThis.HTMLElement,globalThis.SVGElement,globalThis.MathMLElement,globalThis.HTMLBodyElement,globalThis.HTMLFrameSetElement]){
    for(let owner=Constructor?.prototype;owner&&owner!==Element.prototype;owner=Object.getPrototypeOf(owner)){
      let keys=visited.get(owner);if(!keys){keys=new Set();visited.set(owner,keys);}
      for(const key of Object.getOwnPropertyNames(owner)){
        const property=Object.getOwnPropertyDescriptor(owner,key);
        if(!key.startsWith('on')||!property?.get||!property.set||keys.has(key))continue;
        keys.add(key);supported.add(key);
        let setters=nativeHandlers.get(owner);if(!setters){setters=new Map();nativeHandlers.set(owner,setters);}setters.set(key,property.set);
        Object.defineProperty(owner,key,{...property,
          get(){if(!assigning&&this instanceof Element)rewrite_event_attributes(this);return property.get.call(this);},
          set(value){
            const result=property.set.call(this,value);
            if(!assigning&&this instanceof Element)entries(this).set(key,{source:getAttribute.call(this,key),handler:value});
            return result;
          }
        });
      }
    }
  }
  function mutate(element,name,operation){
    if(!(element instanceof Element)||!supported.has(name))return operation();
    const handlers=entries(element),previous=handlers.get(name);handlers.delete(name);
    let result;
    try{result=operation();}
    catch(error){if(previous)handlers.set(name,previous);throw error;}
    // A custom-element callback may have assigned its own property handler.
    // Preserve that assignment rather than reinstalling the attribute body.
    rewrite_event_attributes(element);return result;
  }
  for(const key of ['setAttribute','removeAttribute','toggleAttribute','setAttributeNS','removeAttributeNS','setAttributeNode','setAttributeNodeNS','removeAttributeNode']){
    const original=Element.prototype[key];if(!original)continue;
    Element.prototype[key]=new Proxy(original,{apply(target,receiver,args){
      const required=key==='setAttributeNS'?3:key==='setAttribute'||key==='removeAttributeNS'?2:1;
      if(args.length<required)return Reflect.apply(target,receiver,args);
      let name;
      if(key.includes('AttributeNode')){
        if(args[0] instanceof Attr&&args[0].namespaceURI===null)name=args[0].name;
      }else{
        const namespaced=key.endsWith('NS');
        if(namespaced){
          const namespace=args[0]==null?null:`${args[0]}`;args=[...args];args[0]=namespace;
          if(namespace!==null&&namespace!=='')return Reflect.apply(target,receiver,args);
        }
        const index=namespaced?1:0;
        const converted=`${args[index]}`;args=[...args];args[index]=converted;
        name=!namespaced&&receiver instanceof Element&&namespace.call(receiver)==='http://www.w3.org/1999/xhtml'&&contentType.call(ownerDocument.call(receiver))==='text/html'?converted.toLowerCase():converted;
      }
      if(key==='setAttribute'||key==='setAttributeNS'){
        const index=key==='setAttribute'?1:2;args=[...args];args[index]=`${args[index]}`;
      }
      // A no-op toggle leaves a property override intact in native browsers.
      if(key==='toggleAttribute'&&supported.has(name)){
        const present=getAttribute.call(receiver,name)!==null,wanted=args.length<2?!present:!!args[1];
        if(present===wanted)return Reflect.apply(target,receiver,args);
      }
      return mutate(receiver,name,()=>Reflect.apply(target,receiver,args));
    }});
  }
  for(const [prototype,key] of [[Attr.prototype,'value'],[Node.prototype,'nodeValue'],[Node.prototype,'textContent']]){
    const property=Object.getOwnPropertyDescriptor(prototype,key);if(!property?.set)continue;
    Object.defineProperty(prototype,key,{...property,set(value){
      if(!(this instanceof Attr)||this.namespaceURI!==null||!this.ownerElement)return property.set.call(this,value);
      const text=key==='value'||value!=null?`${value}`:value;
      return mutate(this.ownerElement,this.name,()=>property.set.call(this,text));
    }});
  }
  const maps=new WeakMap(),attributeProperty=Object.getOwnPropertyDescriptor(Element.prototype,'attributes');
  Object.defineProperty(Element.prototype,'attributes',{...attributeProperty,get(){const map=attributeProperty.get.call(this);maps.set(map,this);return map;}});
  for(const key of ['setNamedItem','setNamedItemNS','removeNamedItem','removeNamedItemNS']){
    const original=NamedNodeMap.prototype[key];
    NamedNodeMap.prototype[key]=new Proxy(original,{apply(target,receiver,args){
      const element=maps.get(receiver),attribute=key.startsWith('set')?args[0]:null;
      const name=attribute instanceof Attr&&attribute.namespaceURI===null?attribute.name:key==='removeNamedItem'?`${args[0]}`:key==='removeNamedItemNS'&&(args[0]===null||args[0]==='')?`${args[1]}`:undefined;
      if(key==='removeNamedItem'&&args.length){args=[...args];args[0]=name;}
      else if(key==='removeNamedItemNS'&&name!==undefined&&args.length>=2){args=[...args];args[1]=name;}
      return mutate(element,name,()=>Reflect.apply(target,receiver,args));
    }});
  }
  function prepare(target){
    for(let node=target;node;node=node.parentNode||node.host)if(node instanceof Element)rewrite_event_attributes(node);
  }
  const dispatch=EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent=new Proxy(dispatch,{apply(target,receiver,args){prepare(receiver);return Reflect.apply(target,receiver,args);}});
  const click=HTMLElement.prototype.click;
  HTMLElement.prototype.click=new Proxy(click,{apply(target,receiver,args){prepare(receiver);return Reflect.apply(target,receiver,args);}});
  const capture=event=>{for(const node of event.composedPath())if(node instanceof Element)rewrite_event_attributes(node);};
  const add=EventTarget.prototype.addEventListener;
  for(const name of supported)listen_runtime(globalThis,name.slice(2),capture,true);
  const attachShadow=Element.prototype.attachShadow;
  if(attachShadow)Element.prototype.attachShadow=new Proxy(attachShadow,{apply(target,receiver,args){
    const root=Reflect.apply(target,receiver,args);for(const name of supported)listen_runtime(root,name.slice(2),capture,true);return root;
  }});
}
