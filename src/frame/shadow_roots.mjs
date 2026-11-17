import {on_dom_construction,native_attach_shadow} from './dom_operations.mjs';

const roots=new WeakMap();
const observers=new Set();
export function on_shadow_root(callback){observers.add(callback);}
const get=globalThis.Element&&Object.getOwnPropertyDescriptor(Element.prototype,'shadowRoot').get;
const clonable=globalThis.ShadowRoot&&Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'clonable')?.get;
const host=globalThis.ShadowRoot&&Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'host').get;
const kind=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'nodeType').get;
const getRoot=globalThis.Node?.prototype.getRootNode;
const declarative=new WeakSet();
// Keep clonable closed trees reachable during native copying. Their internal
// open mode is hidden by the mode, visibility, slot and event-path APIs below,
// so native construction and cloning can retain their original timing/state.
const native_declarative=new WeakSet(),closed_copies=new WeakSet();
const native_set_html=globalThis.Element?.prototype.setHTMLUnsafe;
const create=globalThis.Document?.prototype.createElementNS,replace=globalThis.DocumentFragment?.prototype.replaceChildren;
const owner=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'ownerDocument').get;
const mode=globalThis.ShadowRoot&&Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'mode').get;
const internals=new WeakMap(),internal_hosts=new WeakMap(),internals_get=globalThis.ElementInternals&&Object.getOwnPropertyDescriptor(ElementInternals.prototype,'shadowRoot')?.get;
export function shadow_root(element){
  let root=roots.get(element)||get.call(element);
  const attached=internals.get(element);if(!root&&attached&&internals_get)root=internals_get.call(attached);
  if(root)remember_shadow_root(element,root);return root;
}
export function remember_shadow_root(host,root){roots.set(host,root);for(const callback of observers)callback(root);}
export function remember_declarative_root(host,root,native=false){remember_shadow_root(host,root);declarative.add(root);if(native)native_declarative.add(root);}
export const is_declarative_root=root=>declarative.has(root);
export const shadow_mode=root=>closed_copies.has(root)?'closed':mode.call(root);
export function remember_shadow_mode(root,value){if(value==='closed'&&mode.call(root)==='open')closed_copies.add(root);}
export function capture_shadow_state(root){
  const closed=closed_copies.has(root),declared=declarative.has(root),native=native_declarative.has(root);
  return copy=>{if(closed)closed_copies.add(copy);if(declared){declarative.add(copy);if(native)native_declarative.add(copy);}};
}
export function track_shadow_root(root){
  while(host&&root&&kind.call(root)===11){
    let element;try{element=host.call(root);}catch{return;}
    remember_shadow_root(element,root);root=getRoot.call(element);
  }
}
export function clonable_shadow(element){const root=shadow_root(element);return root&&clonable?.call(root)?root:null;}
if(globalThis.Element){
  const attach=Element.prototype.attachShadow;
  if(attach)Element.prototype.attachShadow=new Proxy(attach,{apply(target,receiver,args){
    const existing=roots.get(receiver);
    if(existing&&declarative.has(existing)&&!native_declarative.has(existing)){
      // Native argument conversion also handles throwing/reentrant dictionaries.
      // A private empty declaration preserves native validation and getter order.
      const container=create.call(owner.call(receiver),'http://www.w3.org/1999/xhtml','div');
      native_set_html.call(container,'<div><template shadowrootmode="'+mode.call(existing)+'"></template></div>');
      Reflect.apply(native_attach_shadow,container.firstElementChild,args);
      if(!declarative.has(existing))throw new DOMException('A shadow root is already attached to this element.','NotSupportedError');
      declarative.delete(existing);replace.call(existing);return existing;
    }
    let logical,clones=false;const converted=[...args],input=args[0];
    if(input&&(typeof input==='object'||typeof input==='function'))converted[0]=new Proxy(Object.create(null),{get(_target,key){
      const value=Reflect.get(input,key,input);if(key==='clonable')clones=!!value;
      if(key!=='mode'||value===undefined)return value;
      return {toString(){logical=`${value}`;
        if(existing&&['open','closed'].includes(logical))return logical===shadow_mode(existing)?mode.call(existing):mode.call(existing)==='open'?'closed':'open';
        return logical==='closed'&&clones?'open':logical;
      }};
    }});
    const root=Reflect.apply(target,receiver,converted);remember_shadow_mode(root,logical);
    if(root===existing){declarative.delete(root);native_declarative.delete(root);}
    remember_shadow_root(receiver,root);return root;
  }});
  const property=Object.getOwnPropertyDescriptor(Element.prototype,'shadowRoot');
  Object.defineProperty(Element.prototype,'shadowRoot',{...property,get:new Proxy(property.get,{apply(target,receiver,args){const root=Reflect.apply(target,receiver,args);return root&&closed_copies.has(root)?null:root;}})});
}
if(getRoot&&host){
  const propertyMode=Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'mode');
  Object.defineProperty(ShadowRoot.prototype,'mode',{...propertyMode,get:new Proxy(propertyMode.get,{apply(target,receiver,args){const value=Reflect.apply(target,receiver,args);return closed_copies.has(receiver)?'closed':value;}})});
  for(const prototype of [Element.prototype,globalThis.Text?.prototype])if(prototype){
    const property=Object.getOwnPropertyDescriptor(prototype,'assignedSlot');if(!property?.get)continue;
    Object.defineProperty(prototype,'assignedSlot',{...property,get:new Proxy(property.get,{apply(target,receiver,args){const slot=Reflect.apply(target,receiver,args);return slot&&closed_copies.has(getRoot.call(slot))?null:slot;}})});
  }
  const path=globalThis.Event?.prototype.composedPath,current=globalThis.Event&&Object.getOwnPropertyDescriptor(Event.prototype,'currentTarget').get;
  if(path)Event.prototype.composedPath=new Proxy(path,{apply(target,receiver,args){
    const values=Reflect.apply(target,receiver,args),listener=current.call(receiver);
    const inside=root=>{let node=listener;while(node){let tree;try{tree=getRoot.call(node);}catch{return false;}if(tree===root)return true;try{node=host.call(tree);}catch{return false;}}return false;};
    return values.filter(node=>{let tree;try{tree=getRoot.call(node);}catch{return true;}while(tree){if(closed_copies.has(tree)&&!inside(tree))return false;try{tree=getRoot.call(host.call(tree));}catch{break;}}return true;});
  }});
  Node.prototype.getRootNode=new Proxy(getRoot,{apply(target,receiver,args){const root=Reflect.apply(target,receiver,args);track_shadow_root(root);return root;}});
  on_dom_construction(element=>track_shadow_root(getRoot.call(element)));
  const property=globalThis.ElementInternals&&Object.getOwnPropertyDescriptor(ElementInternals.prototype,'shadowRoot');
  const attachInternals=globalThis.HTMLElement?.prototype.attachInternals;
  if(attachInternals)HTMLElement.prototype.attachInternals=new Proxy(attachInternals,{apply(target,receiver,args){const result=Reflect.apply(target,receiver,args);internals.set(receiver,result);internal_hosts.set(result,receiver);return result;}});
  if(property?.get)Object.defineProperty(ElementInternals.prototype,'shadowRoot',{...property,get:new Proxy(property.get,{apply(target,receiver,args){
    const native=Reflect.apply(target,receiver,args),attached=roots.get(internal_hosts.get(receiver));
    // Streaming declarations attach to a host that may already be observable.
    // Their internals visibility follows declarations without replacing the host.
    const root=native||attached&&declarative.has(attached)&&attached||null;
    track_shadow_root(root);return root;
  }})});
}
