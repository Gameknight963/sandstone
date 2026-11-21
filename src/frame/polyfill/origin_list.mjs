import {document_states} from '../document_identity.mjs';

const views=document_states('origin-lists');
const NativeList=globalThis.DOMStringList;
const native=NativeList&&Object.getOwnPropertyDescriptors(NativeList.prototype);
const from=Array.from,includes=Array.prototype.includes,map=Array.prototype.map,freeze=Object.freeze;
const index=key=>typeof key==='string'&&/^(?:0|[1-9][0-9]*)$/.test(key)&&Number(key)<2**32-1;
if(NativeList){
  for(const name of ['item','contains'])Object.defineProperty(NativeList.prototype,name,{...native[name],value:new Proxy(native[name].value,{apply(target,receiver,args){
    const values=views.get(receiver);
    if(!values)return Reflect.apply(target,receiver,args);
    if(!args.length)throw new TypeError('An argument is required');
    if(name==='item')return values[(+args[0])>>>0]??null;
    return Reflect.apply(includes,values,[`${args[0]}`]);
  }})});
  Object.defineProperty(NativeList.prototype,'length',{...native.length,get:new Proxy(native.length.get,{apply(target,receiver,args){
    const values=views.get(receiver);return values?values.length:Reflect.apply(target,receiver,args);
  }})});
}

// Browser frame ancestors include the standalone host and opaque runtime
// origins. Expose only the virtual document ancestry, keeping native list
// methods usable on both these views and ordinary IndexedDB name lists.
export function origin_list(origins){
  const values=freeze(from(origins)),target=Object.create(NativeList.prototype);
  const view=new Proxy(target,{
    get(target,key,receiver){return index(key)?values[Number(key)]:Reflect.get(target,key,receiver);},
    has(target,key){return index(key)?Number(key)<values.length:Reflect.has(target,key);},
    ownKeys(target){return [...Reflect.apply(map,values,[(_,i)=>String(i)]),...Reflect.ownKeys(target)];},
    getOwnPropertyDescriptor(target,key){return index(key)&&Number(key)<values.length?{value:values[Number(key)],writable:false,enumerable:true,configurable:true}:Reflect.getOwnPropertyDescriptor(target,key);},
    set(target,key,value,receiver){return index(key)?true:Reflect.set(target,key,value,receiver);},
    defineProperty(target,key,descriptor){return index(key)?descriptor.configurable!==false:Reflect.defineProperty(target,key,descriptor);},
    deleteProperty(target,key){return index(key)?Number(key)>=values.length:Reflect.deleteProperty(target,key);},
    preventExtensions(){return false;}
  });
  views.set(view,values);return view;
}
