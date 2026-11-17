const roots=new WeakMap();
const get=globalThis.Element&&Object.getOwnPropertyDescriptor(Element.prototype,'shadowRoot').get;
const clonable=globalThis.ShadowRoot&&Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'clonable')?.get;
export function shadow_root(element){return roots.get(element)||get.call(element);}
export function remember_shadow_root(host,root){roots.set(host,root);}
export function clonable_shadow(element){const root=shadow_root(element);return root&&clonable?.call(root)?root:null;}
if(globalThis.Element){
  const attach=Element.prototype.attachShadow;
  if(attach)Element.prototype.attachShadow=new Proxy(attach,{apply(target,receiver,args){const root=Reflect.apply(target,receiver,args);roots.set(receiver,root);return root;}});
}
