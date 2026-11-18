import {unwrap_frame_document as unwrap_document,document_states} from '../document_identity.mjs';

const Native=globalThis.MutationObserver,observers=document_states('observers'),records=document_states('mutation-records');
const native_target=globalThis.MutationRecord&&Object.getOwnPropertyDescriptor(MutationRecord.prototype,'target');
// Runtime observers keep native record targets. Only observers made through
// the virtual global map targets to the document alias supplied by the page.
const mark=(list,observer)=>{const aliases=observers.get(observer);if(aliases)for(const record of list){const target=native_target.get.call(record);if(aliases.has(target))records.set(record,aliases.get(target));}return list;};
export const MutationObserver=Native&&new Proxy(Native,{construct(target,args,newTarget){
  if(typeof args[0]!=='function')return Reflect.construct(target,args,newTarget);
  const callback=args[0],converted=[...args];
  converted[0]=function(list,observer){return Reflect.apply(callback,this,[mark(list,observer),observer]);};
  const observer=Reflect.construct(target,converted,newTarget);observers.set(observer,new WeakMap());return observer;
}});
if(Native){
  Object.defineProperty(Native.prototype,'constructor',{...Object.getOwnPropertyDescriptor(Native.prototype,'constructor'),value:MutationObserver});
  const observe=Native.prototype.observe,take=Native.prototype.takeRecords;
  Native.prototype.observe=new Proxy(observe,{apply(target,receiver,args){
    const converted=[...args];if(args.length)converted[0]=unwrap_document(args[0]);
    const result=Reflect.apply(target,receiver,converted);
    if(observers.has(receiver))observers.get(receiver).set(converted[0],args[0]);
    return result;
  }});
  Native.prototype.takeRecords=new Proxy(take,{apply(target,receiver,args){const list=Reflect.apply(target,receiver,args);return mark(list,receiver);}});
  const property=Object.getOwnPropertyDescriptor(MutationRecord.prototype,'target');
  Object.defineProperty(MutationRecord.prototype,'target',{...property,get(){const value=property.get.call(this);return records.has(this)?records.get(this):value;}});
}
