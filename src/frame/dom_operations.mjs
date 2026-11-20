// Native HTML constructors return the element before custom-element fields or
// constructor bodies run. Keep that boundary available to DOM copy operations.
const hooks=[],construction_hooks=[],constructors=new WeakMap(),parents=new Map();
const inert_nodes=new WeakSet();
export const native_attach_shadow=globalThis.Element?.prototype.attachShadow;
export const native_dom=globalThis.document&&{
  create:Document.prototype.createElementNS,text:Document.prototype.createTextNode,comment:Document.prototype.createComment,
  adopt:Document.prototype.adoptNode,append:Node.prototype.appendChild,insert:Node.prototype.insertBefore,remove:Node.prototype.removeChild,clone:Node.prototype.cloneNode,
  attribute:Element.prototype.setAttributeNS,plainAttribute:Element.prototype.setAttribute,attributeNode:Element.prototype.setAttributeNodeNS,
  inner:Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML').set,
  data:Object.getOwnPropertyDescriptor(CharacterData.prototype,'data').set,appendData:CharacterData.prototype.appendData,
  parent:Object.getOwnPropertyDescriptor(Node.prototype,'parentNode').get,owner:Object.getOwnPropertyDescriptor(Node.prototype,'ownerDocument').get,
  view:Object.getOwnPropertyDescriptor(Document.prototype,'defaultView').get,template:Object.getOwnPropertyDescriptor(HTMLTemplateElement.prototype,'content').get,
  open:Document.prototype.open,write:Document.prototype.write,writeln:Document.prototype.writeln,close:Document.prototype.close,
  doctype:DOMImplementation.prototype.createDocumentType
};
export function mark_inert_node(node){inert_nodes.add(node);return node;}
export const is_inert_node=node=>inert_nodes.has(node);
export const html_constructor_names=[];
const base=globalThis.HTMLElement?.prototype,isPrototypeOf=Object.prototype.isPrototypeOf;
if(base)for(const [name,property] of Object.entries(Object.getOwnPropertyDescriptors(globalThis))){
  const value=property.value,prototype=typeof value==='function'&&Object.getOwnPropertyDescriptor(value,'prototype')?.value;
  if(!/^HTML.*Element$/.test(name)||!prototype||prototype!==base&&!isPrototypeOf.call(base,prototype))continue;
  html_constructor_names.push(name);
  let wrapper=constructors.get(value);
  if(!wrapper){
    parents.set(value,Object.getPrototypeOf(value));
    wrapper=new Proxy(value,{construct(target,args,newTarget){const element=Reflect.construct(target,args,newTarget);notify_dom_access(element);for(const hook of construction_hooks)hook(element);return element;}});
    constructors.set(value,wrapper);
    const constructor=Object.getOwnPropertyDescriptor(prototype,'constructor');
    if(constructor?.value===value&&constructor.configurable)Object.defineProperty(prototype,'constructor',{...constructor,value:wrapper});
  }
  Object.defineProperty(globalThis,name,{...property,value:wrapper});
}
// Keep interface inheritance consistent with the public constructor objects.
for(const [value,parent] of parents){const replacement=constructors.get(parent);if(replacement)Object.setPrototypeOf(value,replacement);}
export const virtual_html_constructor=value=>constructors.get(value)||value;
export function on_dom_construction(hook){construction_hooks.push(hook);}
export function notify_dom_access(value){if(hooks.length)for(const hook of [...hooks])hook(value);}
export function with_dom_access(hook,operation){hooks.push(hook);try{return operation();}finally{hooks.pop();}}
