import {unwrap_frame_document as unwrap_document,document_states} from '../document_identity.mjs';

const Native=globalThis.MutationObserver,observers=document_states('observers'),records=document_states('mutation-records');
const native_target=globalThis.MutationRecord&&Object.getOwnPropertyDescriptor(MutationRecord.prototype,'target');
const queues=document_states('observer-queues'),live=document_states('live-observer-queues',{weak:false});
const take=Native?.prototype.takeRecords,observe=Native?.prototype.observe;
const text_data=globalThis.CharacterData&&Object.getOwnPropertyDescriptor(CharacterData.prototype,'data');
const native_create_text=globalThis.Document?.prototype.createTextNode;
const internal_attributes=[];
const internal_writes=document_states('internal-attribute-writes');
export const is_internal_attribute_mutation=(element,name)=>!!internal_writes.get(element)?.get(name);
function collect(state,list){
  for(const record of list){
    const target=native_target.get.call(record);
    if(target!==state.sentinel&&!internal_attributes.some(entry=>entry.element===target&&record.type==='attributes'&&record.attributeNamespace===null&&record.attributeName===entry.name))state.buffer.push(record);
  }
}
function signal(state,observer){
  if(!state.buffer.length||state.signaled)return;
  observe.call(observer,state.sentinel,{characterData:true});
  state.signaled=true;text_data.set.call(state.sentinel,text_data.get.call(state.sentinel)==='0'?'1':'0');
}
// Keep queued authored records and native registration rules. A private text
// mutation wakes an observer whose real records were buffered while renderer
// writes were removed. This filters records, not scheduling: a native checkpoint
// created by a hidden write can still advance later same-turn notifications.
export function internal_attribute_mutation(element,name,operation){
  const drain=()=>live.forEach((_,reference)=>{
    const observer=reference.deref();if(!observer){live.delete(reference);return;}
    const state=queues.get(observer);
    const list=take.call(observer);
    collect(state,list);
    state.signaled=false;signal(state,observer);
  });
  drain();internal_attributes.push({element,name});
  const writes=internal_writes.get(element)||new Map();internal_writes.set(element,writes);writes.set(name,(writes.get(name)||0)+1);
  try{return operation();}finally{try{drain();}finally{
    internal_attributes.pop();const count=writes.get(name)-1;if(count)writes.set(name,count);else writes.delete(name);
  }}
}
// Runtime observers keep native record targets. Only observers made through
// the virtual global map targets to the document alias supplied by the page.
const mark=(list,observer)=>{const aliases=observers.get(observer);if(aliases)for(const record of list){const target=native_target.get.call(record);if(aliases.has(target))records.set(record,aliases.get(target));}return list;};
export const MutationObserver=Native&&new Proxy(Native,{construct(target,args,newTarget){
  if(typeof args[0]!=='function')return Reflect.construct(target,args,newTarget);
  const callback=args[0],converted=[...args];
  converted[0]=function(list,observer){
    const state=queues.get(observer);
    if(!state)return Reflect.apply(callback,this,[mark(list,observer),observer]);
    collect(state,list);state.signaled=false;
    const pending=state.buffer;state.buffer=[];
    if(pending.length)return Reflect.apply(callback,this,[mark(pending,observer),observer]);
  };
  const observer=Reflect.construct(target,converted,newTarget);
  if(typeof globalThis.WeakRef==='function'){
    const reference=new WeakRef(observer),state={buffer:[],signaled:false,sentinel:native_create_text.call(document,'0')};
    // The enumerable registry must not retain the sentinel: its native
    // observation would otherwise keep the observer alive through that node.
    queues.set(observer,state);live.set(reference,null);
  }
  observers.set(observer,new WeakMap());return observer;
}});
if(Native){
  Object.defineProperty(Native.prototype,'constructor',{...Object.getOwnPropertyDescriptor(Native.prototype,'constructor'),value:MutationObserver});
  const disconnect=Native.prototype.disconnect;
  Native.prototype.observe=new Proxy(observe,{apply(target,receiver,args){
    const converted=[...args];if(args.length)converted[0]=unwrap_document(args[0]);
    const result=Reflect.apply(target,receiver,converted);
    if(observers.has(receiver))observers.get(receiver).set(converted[0],args[0]);
    return result;
  }});
  Native.prototype.takeRecords=new Proxy(take,{apply(target,receiver,args){
    const list=Reflect.apply(target,receiver,args),state=queues.get(receiver);
    if(!state)return mark(list,receiver);
    collect(state,list);state.signaled=false;
    const pending=state.buffer;state.buffer=[];return mark(pending,receiver);
  }});
  Native.prototype.disconnect=new Proxy(disconnect,{apply(target,receiver,args){
    const result=Reflect.apply(target,receiver,args),state=queues.get(receiver);
    if(state){state.buffer=[];state.signaled=false;}return result;
  }});
  const property=Object.getOwnPropertyDescriptor(MutationRecord.prototype,'target');
  Object.defineProperty(MutationRecord.prototype,'target',{...property,get(){const value=property.get.call(this);return records.has(this)?records.get(this):value;}});
}
