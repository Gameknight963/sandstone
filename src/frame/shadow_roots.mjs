import {on_dom_construction} from './dom_operations.mjs';

const roots=new WeakMap();
const get=globalThis.Element&&Object.getOwnPropertyDescriptor(Element.prototype,'shadowRoot').get;
const clonable=globalThis.ShadowRoot&&Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'clonable')?.get;
const host=globalThis.ShadowRoot&&Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'host').get;
const kind=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'nodeType').get;
const getRoot=globalThis.Node?.prototype.getRootNode;
export function shadow_root(element){return roots.get(element)||get.call(element);}
export function remember_shadow_root(host,root){roots.set(host,root);}
export function track_shadow_root(root){
  while(host&&root&&kind.call(root)===11){
    let element;try{element=host.call(root);}catch{return;}
    roots.set(element,root);root=getRoot.call(element);
  }
}
export function clonable_shadow(element){const root=shadow_root(element);return root&&clonable?.call(root)?root:null;}
if(globalThis.Element){
  const attach=Element.prototype.attachShadow;
  if(attach)Element.prototype.attachShadow=new Proxy(attach,{apply(target,receiver,args){const root=Reflect.apply(target,receiver,args);roots.set(receiver,root);return root;}});
}
if(getRoot&&host){
  Node.prototype.getRootNode=new Proxy(getRoot,{apply(target,receiver,args){const root=Reflect.apply(target,receiver,args);track_shadow_root(root);return root;}});
  on_dom_construction(element=>track_shadow_root(getRoot.call(element)));
  const property=globalThis.ElementInternals&&Object.getOwnPropertyDescriptor(ElementInternals.prototype,'shadowRoot');
  if(property?.get)Object.defineProperty(ElementInternals.prototype,'shadowRoot',{...property,get:new Proxy(property.get,{apply(target,receiver,args){const root=Reflect.apply(target,receiver,args);track_shadow_root(root);return root;}})});
}
