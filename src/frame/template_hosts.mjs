const hosts=new WeakMap();
const prototype=globalThis.HTMLTemplateElement?.prototype;
const property=prototype&&Object.getOwnPropertyDescriptor(prototype,'content');
export const template_host=fragment=>hosts.get(fragment);
if(property?.get)Object.defineProperty(prototype,'content',{...property,get:new Proxy(property.get,{apply(target,receiver,args){const content=Reflect.apply(target,receiver,args);hosts.set(content,receiver);return content;}})});
