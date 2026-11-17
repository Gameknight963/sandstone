import {ctx} from './context.mjs';
import * as network from './network.mjs';
import {schedule_resource_event} from './resource_events.mjs';

const svg='http://www.w3.org/2000/svg',xlink='http://www.w3.org/1999/xlink';
const states=new WeakMap(),strings=new WeakMap(),maps=new WeakMap();
const E=globalThis.Element?.prototype,A=globalThis.Attr?.prototype,N=globalThis.Node?.prototype;
function descriptor(prototype,key){while(prototype){const value=Object.getOwnPropertyDescriptor(prototype,key);if(value)return value;prototype=Object.getPrototypeOf(prototype);}}
const fields=Object.fromEntries(['name','namespaceURI','localName','ownerElement','value'].map(key=>[key,A&&descriptor(A,key)]));
const attributes=E&&descriptor(E,'attributes').get,clone=N?.cloneNode;
const node_type=N&&descriptor(N,'nodeType').get;
const methods=Object.fromEntries(['getAttribute','getAttributeNS','getAttributeNode','getAttributeNodeNS','hasAttribute','hasAttributeNS','setAttribute','setAttributeNS','removeAttribute','removeAttributeNS','toggleAttribute','setAttributeNode','setAttributeNodeNS','removeAttributeNode'].map(key=>[key,E?.[key]]));
const base=globalThis.SVGAnimatedString&&descriptor(SVGAnimatedString.prototype,'baseVal');
const stringify=String;
const text=value=>{if(typeof value==='symbol')throw new TypeError('Cannot convert a Symbol to a string');return stringify(value);};
const nullable=value=>value==null?null:text(value);
const slots=[{ns:null,name:'href'},{ns:xlink,name:'href'}];
let inert;
const value=attr=>fields.value.get.call(attr);
const owner=attr=>fields.ownerElement.get.call(attr);
const ns=attr=>fields.namespaceURI.get.call(attr);
const local=attr=>fields.localName.get.call(attr);
const qualified=attr=>fields.name.get.call(attr);
const resource_attr=attr=>!!attr&&local(attr)==='href'&&(ns(attr)===null||ns(attr)===xlink);
const setting=attr=>!!attr&&ns(attr)===null&&['crossorigin','referrerpolicy'].includes(local(attr));
const attr=(element,namespace,name)=>methods.getAttributeNodeNS.call(element,namespace,name);
const animated=element=>descriptor(Object.getPrototypeOf(element),'href').get.call(element);
function canonical(state,node){const source=attr(state.mirror,ns(node),local(node));return source?value(source):state.values.get(node);}
function detached(state,node){if(node&&!owner(node)&&state.values.has(node))fields.value.set.call(node,state.values.get(node));}

export function is_svg_resource(element){
  return !!(globalThis.SVGImageElement&&element instanceof SVGImageElement||globalThis.SVGFEImageElement&&element instanceof SVGFEImageElement);
}

function render(state,url){
  state.local=url;
  for(const slot of slots){
    const authored=attr(state.mirror,slot.ns,slot.name),current=attr(state.element,slot.ns,slot.name);
    if(!authored){
      if(current){methods.removeAttributeNS.call(state.element,slot.ns,slot.name);detached(state,current);}
    }else{
      methods.setAttributeNS.call(state.element,slot.ns,qualified(authored),url);
      state.values.set(attr(state.element,slot.ns,slot.name),value(authored));
    }
  }
}
function release(state){
  if(!state.blob)return;
  URL.revokeObjectURL(state.blob);delete network.known_urls[state.blob];delete network.known_urls[state.local];state.blob=null;
}
function refresh(state){
  const source=base.get.call(animated(state.mirror)),cors=state.cors?methods.getAttribute.call(state.element,'crossorigin'):null;
  const mode=cors===null?'no-cors':'cors',credentials=cors===null||cors.toLowerCase()==='use-credentials'?'include':'same-origin';
  let url;
  try{url=source?new URL(source,ctx.document.baseURI):null;}catch{}
  const key=JSON.stringify([url?.href??source,mode,credentials]);
  if(state.key===key){render(state,state.local);return state.pending;}
  state.key=key;state.cancelError?.();state.controller?.abort();release(state);
  const generation=++state.generation,controller=state.controller=new AbortController();
  if(!source||source.startsWith('#')&&state.localFragment||url&&['data:','blob:'].includes(url.protocol)){
    render(state,source.startsWith('#')&&state.localFragment?source:url?.href||source);
    state.pending=null;return;
  }
  render(state,'');
  state.pending=(async()=>{
    try{
      if(!url||!['http:','https:'].includes(url.protocol))throw new TypeError('Invalid SVG image URL');
      const response=await network.fetch(url.href,{signal:controller.signal,mode,credentials});
      if(!response.ok){await response.body?.cancel();throw new TypeError('SVG image request failed: '+response.status);}
      const blob=await response.blob();controller.signal.throwIfAborted();
      if(state.generation!==generation)return;
      state.blob=network.create_blob_url(blob,url.href);
      const local=state.blob+url.hash;network.known_urls[local]=url.href;
      render(state,local);
    }catch(error){
      if(state.generation!==generation||controller.signal.aborted)return;
      state.key=null;
      state.cancelError=schedule_resource_event(state.element,()=>{if(state.generation===generation)state.element.dispatchEvent(new Event('error'));});
    }finally{if(state.generation===generation)state.pending=null;}
  })();
  return state.pending;
}

export function rewrite_svg_resource(element,source){
  if(states.has(element))return states.get(element).pending;
  inert??=document.implementation.createHTMLDocument('');
  const mirror=inert.createElementNS(svg,element.localName),state={element,mirror,values:new WeakMap(),generation:0,local:'',key:null,cors:!!descriptor(Object.getPrototypeOf(element),'crossOrigin'),localFragment:!!(globalThis.SVGFEImageElement&&element instanceof SVGFEImageElement)};
  for(const slot of slots){
    const original=attr(source?.mirror||element,slot.ns,slot.name);
    if(original)methods.setAttributeNS.call(mirror,slot.ns,qualified(original),value(original));
  }
  states.set(element,state);strings.set(animated(element),state);maps.set(attributes.call(element),state);
  element.addEventListener('error',event=>{if(event.isTrusted&&(!state.local||state.pending))event.stopImmediatePropagation();},true);
  return refresh(state);
}
export function clone_svg_resource(source,copy){
  const state=states.get(source);
  if(state){rewrite_svg_resource(copy,state);return true;}
  if(A&&source instanceof Attr){
    const state=states.get(owner(source));
    if(state&&resource_attr(source)){fields.value.set.call(copy,canonical(state,source));return true;}
  }
  return false;
}

function attach(state,node,namespaced,operation){
  const parent=owner(node);
  if(parent&&parent!==state.element)return operation();
  const previous=namespaced?attr(state.element,ns(node),local(node)):methods.getAttributeNode.call(state.element,qualified(node));
  if(!resource_attr(node)&&!resource_attr(previous)){
    const result=operation();if(setting(node)||setting(previous))refresh(state);return result;
  }
  if(parent===state.element)return operation();
  const authored=value(node),copy=clone.call(node,false),key=namespaced?'setAttributeNodeNS':'setAttributeNode';
  if(resource_attr(node))fields.value.set.call(node,'');
  let result;
  try{result=operation();}
  catch(error){if(!owner(node))fields.value.set.call(node,authored);throw error;}
  fields.value.set.call(copy,authored);methods[key].call(state.mirror,copy);
  detached(state,result);refresh(state);return result;
}
function remove_node(state,node,operation){
  if(owner(node)!==state.element||!resource_attr(node)){
    const result=operation();if(setting(node))refresh(state);return result;
  }
  const source=attr(state.mirror,ns(node),local(node)),result=operation();
  if(source)methods.removeAttributeNode.call(state.mirror,source);
  detached(state,result);refresh(state);return result;
}

if(E&&base){
  // Keep the native SVGAnimatedString object and its receiver checks intact.
  for(const key of ['baseVal','animVal']){
    const property=descriptor(SVGAnimatedString.prototype,key);
    Object.defineProperty(SVGAnimatedString.prototype,key,{...property,
      get(){const native=property.get.call(this),state=strings.get(this);if(!state)return native;
        if(key==='animVal'&&native!==base.get.call(this))return network.known_urls[native]||native;
        return property.get.call(animated(state.mirror));
      },
      ...(property.set?{set:new Proxy(property.set,{apply(target,receiver,args){
        property.get.call(receiver);const state=strings.get(receiver);
        if(!state)return Reflect.apply(target,receiver,args);
        const result=Reflect.apply(target,animated(state.mirror),args);refresh(state);return result;
      }})}:{})
    });
  }
  const counts={getAttribute:1,getAttributeNS:2,getAttributeNode:1,getAttributeNodeNS:2,hasAttribute:1,hasAttributeNS:2,setAttribute:2,setAttributeNS:3,removeAttribute:1,removeAttributeNS:2,toggleAttribute:1};
  for(const [key,count] of Object.entries(counts)){
    E[key]=new Proxy(methods[key],{apply(target,receiver,args){
      const state=states.get(receiver);if(!state||args.length<count)return Reflect.apply(target,receiver,args);
      const namespaced=key.endsWith('NS'),converted=[...args],mutating=key.startsWith('set')||key.startsWith('remove')||key==='toggleAttribute';
      if(namespaced){converted[0]=nullable(args[0]);converted[1]=text(args[1]);if(key==='setAttributeNS')converted[2]=text(args[2]);}
      else{converted[0]=text(args[0]);if(key==='setAttribute')converted[1]=text(args[1]);if(key==='toggleAttribute'&&args.length>1)converted[1]=!!args[1];}
      const existing=namespaced?attr(receiver,converted[0],key==='setAttributeNS'?converted[1].split(':').at(-1):converted[1]):methods.getAttributeNode.call(receiver,converted[0]);
      const protected_attr=resource_attr(existing)||!existing&&(namespaced?(converted[0]===null||converted[0]===xlink)&&(key==='setAttributeNS'?converted[1].split(':').at(-1):converted[1])==='href':converted[0]==='href');
      if(protected_attr){
        if(key.includes('AttributeNode'))return Reflect.apply(target,receiver,converted);
        const result=Reflect.apply(target,state.mirror,converted);
        if(mutating)refresh(state);
        return result;
      }
      const result=Reflect.apply(target,receiver,converted);
      if(mutating&&(setting(existing)||(namespaced?converted[0]===null&&['crossorigin','referrerpolicy'].includes(converted[1]):['crossorigin','referrerpolicy'].includes(converted[0]))))refresh(state);
      return result;
    }});
  }
  for(const key of ['setAttributeNode','setAttributeNodeNS','removeAttributeNode']){
    E[key]=new Proxy(methods[key],{apply(target,receiver,args){
      const state=states.get(receiver);if(!state||!args.length)return Reflect.apply(target,receiver,args);
      return key==='removeAttributeNode'?remove_node(state,args[0],()=>Reflect.apply(target,receiver,args)):
        attach(state,args[0],key.endsWith('NS'),()=>Reflect.apply(target,receiver,args));
    }});
  }
  for(const [prototype,key] of [[A,'value'],[N,'nodeValue'],[N,'textContent']]){
    const property=descriptor(prototype,key);
    const attribute=node=>node_type.call(node)===2?fields.ownerElement.get.call(node):null;
    Object.defineProperty(prototype,key,{...property,
      get(){const native=property.get.call(this),state=states.get(attribute(this));return state&&resource_attr(this)?canonical(state,this):native;},
      set:new Proxy(property.set,{apply(target,receiver,args){
        property.get.call(receiver);let state=states.get(attribute(receiver));
        if(!state||!resource_attr(receiver)||!args.length){const result=Reflect.apply(target,receiver,args);state=states.get(attribute(receiver));if(state&&setting(receiver))refresh(state);return result;}
        const converted=key==='value'?text(args[0]):nullable(args[0]);state=states.get(attribute(receiver));
        if(!state)return Reflect.apply(target,receiver,[converted]);
        const source=attr(state.mirror,ns(receiver),local(receiver));
        const result=Reflect.apply(target,source,[converted]);refresh(state);return result;
      }})
    });
  }
  for(const key of ['setNamedItem','setNamedItemNS','removeNamedItem','removeNamedItemNS']){
    const target=NamedNodeMap.prototype[key];
    NamedNodeMap.prototype[key]=new Proxy(target,{apply(original,receiver,args){
      const state=maps.get(receiver);if(!state||args.length<(key.endsWith('NS')&&key.startsWith('remove')?2:1))return Reflect.apply(original,receiver,args);
      if(key.startsWith('set'))return attach(state,args[0],key.endsWith('NS'),()=>Reflect.apply(original,receiver,args));
      const converted=key.endsWith('NS')?[nullable(args[0]),text(args[1])]:[text(args[0])];
      const node=key.endsWith('NS')?attr(state.element,...converted):methods.getAttributeNode.call(state.element,converted[0]);
      if(!node)return Reflect.apply(original,receiver,converted);
      return remove_node(state,node,()=>Reflect.apply(original,receiver,converted));
    }});
  }
  for(const Constructor of [globalThis.SVGImageElement,globalThis.SVGFEImageElement]){
    const property=Constructor&&descriptor(Constructor.prototype,'crossOrigin');if(!property?.set)continue;
    Object.defineProperty(Constructor.prototype,'crossOrigin',{...property,set:new Proxy(property.set,{apply(target,receiver,args){const result=Reflect.apply(target,receiver,args);const state=states.get(receiver);if(state)refresh(state);return result;}})});
  }
}
