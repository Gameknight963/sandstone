import {unwrap_frame_document,document_states} from '../document_identity.mjs';

const Native=globalThis.IntersectionObserver,roots=document_states('intersection-observer-roots');
export const IntersectionObserver=Native&&new Proxy(Native,{construct(target,args,newTarget){
  const options=args[1],converted=[...args];let alias;
  if(options!==null&&(typeof options==='object'||typeof options==='function'))converted[1]=new Proxy(Object.create(null),{get(_target,key){
    const value=Reflect.get(options,key,options);
    if(key!=='root')return value;
    const root=unwrap_frame_document(value);if(root!==value)alias=value;return root;
  }});
  const observer=Reflect.construct(target,converted,newTarget);
  if(alias)roots.set(observer,alias);
  return observer;
}});
if(Native){
  Object.defineProperty(Native.prototype,'constructor',{...Object.getOwnPropertyDescriptor(Native.prototype,'constructor'),value:IntersectionObserver});
  const root=Object.getOwnPropertyDescriptor(Native.prototype,'root');
  Object.defineProperty(Native.prototype,'root',{...root,get:new Proxy(root.get,{apply(target,receiver,args){
    const value=Reflect.apply(target,receiver,args);return roots.has(receiver)?roots.get(receiver):value;
  }})});
}
