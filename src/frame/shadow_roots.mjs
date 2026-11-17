import {on_dom_construction,native_attach_shadow} from './dom_operations.mjs';

const roots=new WeakMap();
const get=globalThis.Element&&Object.getOwnPropertyDescriptor(Element.prototype,'shadowRoot').get;
const clonable=globalThis.ShadowRoot&&Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'clonable')?.get;
const host=globalThis.ShadowRoot&&Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'host').get;
const kind=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'nodeType').get;
const getRoot=globalThis.Node?.prototype.getRootNode;
const declarative=new WeakSet();
const internals_visible=new WeakSet();
const pending_registries=new WeakSet();
const internals_hosts=new WeakMap();
const native_set_html=globalThis.Element?.prototype.setHTMLUnsafe;
const create=globalThis.Document?.prototype.createElementNS,replace=globalThis.DocumentFragment?.prototype.replaceChildren;
const owner=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'ownerDocument').get;
const mode=globalThis.ShadowRoot&&Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'mode').get;
export function shadow_root(element){return roots.get(element)||get.call(element);}
export function remember_shadow_root(host,root){roots.set(host,root);}
export function remember_declarative_root(host,root,inherit=true){roots.set(host,root);declarative.add(root);internals_visible.add(root);if(inherit)pending_registries.add(root);}
const initialize=globalThis.CustomElementRegistry?.prototype.initialize;
const child_nodes=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'childNodes').get;
const append_child=globalThis.Node?.prototype.appendChild,remove_child=globalThis.Node?.prototype.removeChild;
export function initialize_declarative_root(host){
  const root=roots.get(host);if(!root||!pending_registries.has(root)||!host.ownerDocument.defaultView)return;
  pending_registries.delete(root);const registry=host.customElementRegistry;
  if(initialize&&registry){
    // initialize() upgrades descendants immediately. Assign the registry on an
    // empty, detached root, so native insertion retains shadow-including custom
    // element reaction order when the complete host is connected.
    const children=[...child_nodes.call(root)];for(const child of children)remove_child.call(root,child);
    try{initialize.call(registry,root);}finally{for(const child of children)append_child.call(root,child);}
  }
}
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
  if(attachInternals)HTMLElement.prototype.attachInternals=new Proxy(attachInternals,{apply(target,receiver,args){const result=Reflect.apply(target,receiver,args);internals_hosts.set(result,receiver);return result;}});
  if(property?.get)Object.defineProperty(ElementInternals.prototype,'shadowRoot',{...property,get:new Proxy(property.get,{apply(target,receiver,args){
    const native=Reflect.apply(target,receiver,args),remembered=roots.get(internals_hosts.get(receiver));
    const root=native||(remembered&&internals_visible.has(remembered)?remembered:null);track_shadow_root(root);return root;
  }})});
}
