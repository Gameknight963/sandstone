import {on_dom_construction,native_attach_shadow} from './dom_operations.mjs';

const roots=new WeakMap();
const get=globalThis.Element&&Object.getOwnPropertyDescriptor(Element.prototype,'shadowRoot').get;
const clonable=globalThis.ShadowRoot&&Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'clonable')?.get;
const host=globalThis.ShadowRoot&&Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'host').get;
const kind=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'nodeType').get;
const getRoot=globalThis.Node?.prototype.getRootNode;
const declarative=new WeakSet();
const native_set_html=globalThis.Element?.prototype.setHTMLUnsafe;
const create=globalThis.Document?.prototype.createElementNS,replace=globalThis.DocumentFragment?.prototype.replaceChildren;
const owner=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'ownerDocument').get;
const mode=globalThis.ShadowRoot&&Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'mode').get;
const internals=new WeakMap(),internals_get=globalThis.ElementInternals&&Object.getOwnPropertyDescriptor(ElementInternals.prototype,'shadowRoot')?.get;
export function shadow_root(element){
  let root=roots.get(element)||get.call(element);
  const attached=internals.get(element);if(!root&&attached&&internals_get)root=internals_get.call(attached);
  if(root)roots.set(element,root);return root;
}
export function remember_shadow_root(host,root){roots.set(host,root);}
export function remember_declarative_root(host,root){roots.set(host,root);declarative.add(root);}
export const is_declarative_root=root=>declarative.has(root);
export function track_shadow_root(root){
  while(host&&root&&kind.call(root)===11){
    let element;try{element=host.call(root);}catch{return;}
    roots.set(element,root);root=getRoot.call(element);
  }
}
export function clonable_shadow(element){const root=shadow_root(element);return root&&clonable?.call(root)?root:null;}
if(globalThis.Element){
  const attach=Element.prototype.attachShadow;
  if(attach)Element.prototype.attachShadow=new Proxy(attach,{apply(target,receiver,args){
    const existing=roots.get(receiver);
    if(existing&&declarative.has(existing)){
      // Native argument conversion also handles throwing/reentrant dictionaries.
      // A private empty declaration preserves native validation and getter order.
      const container=create.call(owner.call(receiver),'http://www.w3.org/1999/xhtml','div');
      native_set_html.call(container,'<div><template shadowrootmode="'+mode.call(existing)+'"></template></div>');
      Reflect.apply(native_attach_shadow,container.firstElementChild,args);
      if(!declarative.has(existing))throw new DOMException('A shadow root is already attached to this element.','NotSupportedError');
      declarative.delete(existing);replace.call(existing);return existing;
    }
    const root=Reflect.apply(target,receiver,args);roots.set(receiver,root);return root;
  }});
}
if(getRoot&&host){
  Node.prototype.getRootNode=new Proxy(getRoot,{apply(target,receiver,args){const root=Reflect.apply(target,receiver,args);track_shadow_root(root);return root;}});
  on_dom_construction(element=>track_shadow_root(getRoot.call(element)));
  const property=globalThis.ElementInternals&&Object.getOwnPropertyDescriptor(ElementInternals.prototype,'shadowRoot');
  const attachInternals=globalThis.HTMLElement?.prototype.attachInternals;
  if(attachInternals)HTMLElement.prototype.attachInternals=new Proxy(attachInternals,{apply(target,receiver,args){const result=Reflect.apply(target,receiver,args);internals.set(receiver,result);return result;}});
  if(property?.get)Object.defineProperty(ElementInternals.prototype,'shadowRoot',{...property,get:new Proxy(property.get,{apply(target,receiver,args){const root=Reflect.apply(target,receiver,args);track_shadow_root(root);return root;}})});
}
