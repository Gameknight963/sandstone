// Keep native Attr and NamedNodeMap objects while the renderer sees local URLs.
import {internal_attribute_mutation} from './intercept/mutation_observer.mjs';
import {before_attribute_reaction} from './media_reactions.mjs';
const E=globalThis.Element?.prototype,A=globalThis.Attr?.prototype,N=globalThis.Node?.prototype;
const states=new WeakMap(),maps=new WeakMap();
const methods=Object.fromEntries(['getAttribute','getAttributeNS','getAttributeNode','getAttributeNodeNS','hasAttribute','hasAttributeNS','setAttribute','setAttributeNS','removeAttribute','removeAttributeNS','toggleAttribute','setAttributeNode','setAttributeNodeNS','removeAttributeNode'].map(key=>[key,E?.[key]]));
const attributes=E&&Object.getOwnPropertyDescriptor(E,'attributes').get;
const field=key=>A&&Object.getOwnPropertyDescriptor(A,key).get;
const owner=field('ownerElement'),namespace=field('namespaceURI'),local=field('localName'),name=field('name');
const value=A&&Object.getOwnPropertyDescriptor(A,'value'),clone=N?.cloneNode;
const node_type=N&&Object.getOwnPropertyDescriptor(N,'nodeType').get;
const owner_document=N&&Object.getOwnPropertyDescriptor(N,'ownerDocument').get;
const content_type=globalThis.Document&&Object.getOwnPropertyDescriptor(Document.prototype,'contentType').get;
const create=globalThis.Document?.prototype.createElementNS;
const text=input=>`${input}`,nullable=input=>input==null?null:text(input);
const attr=(element,ns,key)=>methods.getAttributeNodeNS.call(element,ns,key);
const resource=(state,node)=>!!node&&namespace.call(node)===null&&state.authored.has(local.call(node));
const authored=(state,node)=>state.authored.get(local.call(node));
let inert;
export const media_placeholder='data:application/octet-stream,';
export const raw_media_attribute=(element,key)=>methods.getAttributeNS.call(element,null,key);
export const media_attribute_mirror=element=>states.get(element)?.mirror;
export function pending_media_attribute(element,key){
  const state=states.get(element);
  if(state?.pending)return !!state.pending(key);
  return placeholder_media_attribute(element,key);
}
export function placeholder_media_attribute(element,key){
  const state=states.get(element),source=methods.getAttributeNS.call(element,null,key);
  return source===media_placeholder||key==='srcset'&&source===''&&state.authored.get(key)!=='';
}

export function register_media_attributes(element,authored,update,remove,pending){
  if(states.has(element))return;
  inert??=document.implementation.createHTMLDocument('');
  const mirror=create.call(inert,'http://www.w3.org/1999/xhtml',element.localName);
  for(const [key,source] of authored)if(source!==null)methods.setAttribute.call(mirror,key,source);
  const state={element,mirror,authored,update,remove,pending,values:new WeakMap()};
  states.set(element,state);maps.set(attributes.call(element),state);
  for(const [key,source] of authored){const node=attr(element,null,key);if(node)state.values.set(node,source);}
}
function detached(state,node){
  if(node&&!owner.call(node)&&state.values.has(node))value.set.call(node,state.values.get(node));
}
export function render_media_attribute(element,key,source,preserve=false){
  const state=states.get(element),original=attr(element,null,key),canonical=state.authored.get(key);
  if(canonical===null){
    methods.removeAttributeNS.call(state.mirror,null,key);
    methods.removeAttributeNS.call(element,null,key);detached(state,original);
  }else{
    methods.setAttributeNS.call(state.mirror,null,key,canonical);
    if(!preserve)methods.setAttributeNS.call(element,null,key,source);
    const node=attr(element,null,key);if(node)state.values.set(node,canonical);
  }
}
// A selected source may outlive its source node. Keep its temporary renderer
// URL separate from the authored attribute map while resource selection starts.
export function render_internal_media_attribute(element,key,source){
  return internal_attribute_mutation(element,key,()=>{
    if(source===null)methods.removeAttributeNS.call(element,null,key);
    else methods.setAttributeNS.call(element,null,key,source);
  });
}
// Use navigation-time permissions for the synchronous native navigation call.
// Restore the same Attr before any authored reaction, including a reaction to
// the source attribute written by operation. Its value and identity stay live.
export function with_internal_media_attribute(element,key,source,operation){
  const original=attr(element,null,key),previous=original&&value.get.call(original);let restored=false;
  if(previous===source)return operation();
  const restore=()=>{
    if(restored)return;restored=true;
    internal_attribute_mutation(element,key,()=>{
      if(original){value.set.call(original,previous);if(owner.call(original)!==element)methods.setAttributeNode.call(element,original);}
      else methods.removeAttributeNS.call(element,null,key);
    });
  };
  const release=before_attribute_reaction(element,restore);
  try{render_internal_media_attribute(element,key,source);return operation();}
  finally{restore();release();}
}
function refresh(state,key){
  const source=methods.getAttributeNS.call(state.mirror,null,key);
  if(source===null)state.remove(key);
  else state.update(key,source);
}
function remove_node(state,node,operation){
  if(owner.call(node)!==state.element||!resource(state,node))return operation();
  const key=local.call(node),old=authored(state,node);
  state.values.set(node,old);
  const result=operation();
  methods.removeAttributeNS.call(state.mirror,null,key);refresh(state,key);detached(state,node);
  return result;
}
export function detach_media_attribute_node(node){
  const state=states.get(owner.call(node));if(!state||!resource(state,node))return false;
  remove_node(state,node,()=>methods.removeAttributeNode.call(state.element,node));return true;
}
function attach(state,node,namespaced,operation){
  // Let native Web IDL checks handle non-Attr arguments and in-use nodes.
  let parent;
  try{parent=owner.call(node);}catch{return operation();}
  if(parent)return operation();
  const previous=namespaced?attr(state.element,namespace.call(node),local.call(node)):methods.getAttributeNode.call(state.element,name.call(node));
  const incoming=resource(state,node),outgoing=resource(state,previous);
  if(!incoming&&!outgoing)return operation();
  const source=value.get.call(node),copy=clone.call(node,false),key=incoming?local.call(node):local.call(previous);
  if(outgoing)state.values.set(previous,authored(state,previous));
  if(incoming)value.set.call(node,local.call(node)==='srcset'?'':media_placeholder);
  let result;
  try{result=operation();}catch(error){if(incoming&&!owner.call(node))value.set.call(node,source);throw error;}
  methods[namespaced?'setAttributeNodeNS':'setAttributeNode'].call(state.mirror,copy);
  if(incoming)state.values.set(node,source);
  refresh(state,key);detached(state,result);return result;
}
if(E){
  const counts={getAttribute:1,getAttributeNS:2,getAttributeNode:1,getAttributeNodeNS:2,hasAttribute:1,hasAttributeNS:2,setAttribute:2,setAttributeNS:3,removeAttribute:1,removeAttributeNS:2,toggleAttribute:1};
  for(const [key,count] of Object.entries(counts))E[key]=new Proxy(methods[key],{apply(target,receiver,args){
    const state=states.get(receiver);if(!state||args.length<count)return Reflect.apply(target,receiver,args);
    const ns=key.endsWith('NS'),converted=[...args],mutating=key.startsWith('set')||key.startsWith('remove')||key==='toggleAttribute';
    if(ns){converted[0]=nullable(args[0]);converted[1]=text(args[1]);if(key==='setAttributeNS')converted[2]=text(args[2]);}
    else{converted[0]=text(args[0]);if(key==='setAttribute')converted[1]=text(args[1]);if(key==='toggleAttribute'&&args.length>1)converted[1]=!!args[1];}
    const normalized=ns?converted[1]:content_type.call(owner_document.call(receiver))==='text/html'?converted[0].toLowerCase():converted[0];
    const local_name=ns&&key==='setAttributeNS'?normalized.split(':').at(-1):normalized;
    const existing=ns?attr(receiver,converted[0],local_name):methods.getAttributeNode.call(receiver,converted[0]);
    const managed=resource(state,existing)||!existing&&(!ns||converted[0]===null||converted[0]==='')&&state.authored.has(local_name);
    if(!managed)return Reflect.apply(target,receiver,converted);
    // Node-returning accessors must return the actual attached native Attr.
    if(key==='getAttributeNode'||key==='getAttributeNodeNS')return state.authored.get(local_name)===null?null:Reflect.apply(target,receiver,converted);
    const previous=existing&&state.values.get(existing);
    const before=methods.getAttributeNS.call(state.mirror,null,local_name);
    const result=Reflect.apply(target,state.mirror,converted);
    if(mutating){
      if(existing&&previous!==undefined)state.values.set(existing,previous);
      const after=methods.getAttributeNS.call(state.mirror,null,local_name);
      if(key!=='toggleAttribute'||before!==after)refresh(state,local_name);
    }
    return result;
  }});
  for(const key of ['setAttributeNode','setAttributeNodeNS','removeAttributeNode'])E[key]=new Proxy(methods[key],{apply(target,receiver,args){
    const state=states.get(receiver);if(!state||!args.length)return Reflect.apply(target,receiver,args);
    if(key==='removeAttributeNode'){
      try{owner.call(args[0]);}catch{return Reflect.apply(target,receiver,args);}
      return remove_node(state,args[0],()=>Reflect.apply(target,receiver,args));
    }
    return attach(state,args[0],key.endsWith('NS'),()=>Reflect.apply(target,receiver,args));
  }});
  for(const [prototype,key] of [[A,'value'],[N,'nodeValue'],[N,'textContent']]){
    const property=Object.getOwnPropertyDescriptor(prototype,key);
    const state_for=node=>node_type.call(node)===2?states.get(owner.call(node)):undefined;
    Object.defineProperty(prototype,key,{...property,
      get:new Proxy(property.get,{apply(target,receiver,args){const native=Reflect.apply(target,receiver,args),state=state_for(receiver);return state&&resource(state,receiver)?authored(state,receiver):native;}}),
      set:new Proxy(property.set,{apply(target,receiver,args){
        property.get.call(receiver);let state=state_for(receiver);
        if(!state||!resource(state,receiver)||!args.length)return Reflect.apply(target,receiver,args);
        const converted=key==='value'?text(args[0]):nullable(args[0]);state=state_for(receiver);
        if(!state||!resource(state,receiver))return Reflect.apply(target,receiver,[converted]);
        const field=local.call(receiver),mirror=attr(state.mirror,null,field);
        const result=Reflect.apply(target,mirror,[converted]);refresh(state,field);return result;
      }})});
  }
  for(const key of ['setNamedItem','setNamedItemNS','removeNamedItem','removeNamedItemNS']){
    const original=NamedNodeMap.prototype[key];
    NamedNodeMap.prototype[key]=new Proxy(original,{apply(target,receiver,args){
      const state=maps.get(receiver),required=key==='removeNamedItemNS'?2:1;
      if(!state||args.length<required)return Reflect.apply(target,receiver,args);
      if(key.startsWith('set'))return attach(state,args[0],key.endsWith('NS'),()=>Reflect.apply(target,receiver,args));
      const converted=key.endsWith('NS')?[nullable(args[0]),text(args[1])]:[text(args[0])];
      const node=key.endsWith('NS')?attr(state.element,...converted):methods.getAttributeNode.call(state.element,converted[0]);
      if(!node)return Reflect.apply(target,receiver,converted);
      return remove_node(state,node,()=>Reflect.apply(target,receiver,converted));
    }});
  }
}
