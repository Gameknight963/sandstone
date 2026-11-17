const sources=new WeakMap();
const set=globalThis.Element?.prototype.setAttribute,remove=globalThis.Element?.prototype.removeAttribute;
export function resource_attribute(element,name,read){let fields=sources.get(element);if(!fields){fields=new Map();sources.set(element,fields);}fields.set(name,read);}
export function copy_resource_attributes(source,copy){
  for(const [name,read] of sources.get(source)||[]){const value=read();if(value===null)remove.call(copy,name);else set.call(copy,name,value);}
}
