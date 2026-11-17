// Native HTML constructors return the element before custom-element fields or
// constructor bodies run. Keep that boundary available to DOM copy operations.
const hooks=[],constructors=new WeakMap(),parents=new Map();
export const html_constructor_names=[];
const base=globalThis.HTMLElement?.prototype,isPrototypeOf=Object.prototype.isPrototypeOf;
if(base)for(const [name,property] of Object.entries(Object.getOwnPropertyDescriptors(globalThis))){
  const value=property.value,prototype=typeof value==='function'&&Object.getOwnPropertyDescriptor(value,'prototype')?.value;
  if(!/^HTML.*Element$/.test(name)||!prototype||prototype!==base&&!isPrototypeOf.call(base,prototype))continue;
  html_constructor_names.push(name);
  let wrapper=constructors.get(value);
  if(!wrapper){
    parents.set(value,Object.getPrototypeOf(value));
    wrapper=new Proxy(value,{construct(target,args,newTarget){const element=Reflect.construct(target,args,newTarget);notify_dom_access(element);return element;}});
    constructors.set(value,wrapper);
    const constructor=Object.getOwnPropertyDescriptor(prototype,'constructor');
    if(constructor?.value===value&&constructor.configurable)Object.defineProperty(prototype,'constructor',{...constructor,value:wrapper});
  }
  Object.defineProperty(globalThis,name,{...property,value:wrapper});
}
// Keep interface inheritance consistent with the public constructor objects.
for(const [value,parent] of parents){const replacement=constructors.get(parent);if(replacement)Object.setPrototypeOf(value,replacement);}
export const virtual_html_constructor=value=>constructors.get(value)||value;
export function notify_dom_access(value){if(hooks.length)for(const hook of [...hooks])hook(value);}
export function with_dom_access(hook,operation){hooks.push(hook);try{return operation();}finally{hooks.pop();}}
