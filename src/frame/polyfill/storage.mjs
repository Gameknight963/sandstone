// Keep the storage state independent of the frame runtime. Same-origin realms
// share a weak brand registry so borrowed native methods can accept their views.
const states=new WeakMap(),registries=new Set([states]);
function lookup(receiver){
  for(const registry of registries){const state=registry.get(receiver);if(state)return state;}
}
export const is_virtual_storage=receiver=>!!lookup(receiver);
function brand(receiver){
  const value=lookup(receiver);if(!value)throw new TypeError('Illegal invocation');
  return value;
}
function state(receiver){const value=brand(receiver);value.validate();return value;}
export const storage_entries=receiver=>[...brand(receiver).map];
export function replace_storage_entries(receiver,entries){brand(receiver).map=new Map(entries);}
function text(value){if(typeof value==='symbol')throw new TypeError('Cannot convert a Symbol to a string');return String(value);}
function required(count,actual){if(actual<count)throw new TypeError('Not enough arguments');}
const native_define=Object.defineProperty,native_defines=Object.defineProperties,native_descriptor=Object.getOwnPropertyDescriptor,native_reflect_define=Reflect.defineProperty;
function inherited(target,key){
  for(let prototype=Object.getPrototypeOf(target);prototype;prototype=Object.getPrototypeOf(prototype)){
    const descriptor=native_descriptor(prototype,key);if(descriptor)return descriptor;
  }
}
function define(receiver,key,descriptor,reflect=false){
  // Let the engine perform ToPropertyKey and ToPropertyDescriptor exactly once.
  const holder={};native_define(holder,key,descriptor);
  const property=Reflect.ownKeys(holder)[0],converted=native_descriptor(holder,property);
  const target=brand(receiver).target;
  if(typeof property==='symbol'||native_descriptor(target,property))return native_reflect_define(target,property,converted);
  if('get' in converted||'set' in converted)return reflect;
  FakeStorage.prototype.setItem.call(receiver,property,converted.value);return true;
}

export class FakeStorage {
  constructor(entries=[],sync=()=>{},validate=()=>{},{prototype=new.target.prototype,registry=states}={}){
    const value={map:new Map(entries),sync,validate};
    const target=Object.create(prototype);
    value.target=target;
    const proxy=new Proxy(target,{
      get(target,key,receiver){
        if(typeof key==='symbol'||key in target)return Reflect.get(target,key,receiver);
        validate();return value.map.get(key);
      },
      set(target,key,item,receiver){
        if(typeof key!=='string'||native_descriptor(target,key))return Reflect.set(target,key,item,receiver);
        FakeStorage.prototype.setItem.call(proxy,key,item);return true;
      },
      deleteProperty(target,key){
        if(typeof key!=='string'||native_descriptor(target,key))return Reflect.deleteProperty(target,key);
        FakeStorage.prototype.removeItem.call(proxy,key);return true;
      },
      ownKeys(){validate();return [...value.map.keys(),...Reflect.ownKeys(target).filter(key=>!value.map.has(key))];},
      has(target,key){if(typeof key==='symbol')return key in target;validate();return key in target||value.map.has(key);},
      getOwnPropertyDescriptor(target,key){
        const own=native_descriptor(target,key);if(own||typeof key==='symbol')return own;
        validate();return typeof key==='string'&&inherited(target,key)?undefined:value.map.has(key)?{value:value.map.get(key),writable:true,enumerable:true,configurable:true}:undefined;
      },
      defineProperty(target,key,descriptor){
        if(typeof key==='symbol'||native_descriptor(target,key))return native_reflect_define(target,key,descriptor);
        if('get' in descriptor||'set' in descriptor)return false;
        FakeStorage.prototype.setItem.call(proxy,key,descriptor.value);return true;
      },
      preventExtensions(){return false;}
    });
    registries.add(registry);registry.set(proxy,value);states.set(proxy,value);
    return proxy;
  }
  get length(){return state(this).map.size;}
  key(index){const value=brand(this);required(1,arguments.length);index=(+index)>>>0;value.validate();return [...value.map.keys()][index]??null;}
  getItem(key){const value=brand(this);required(1,arguments.length);key=text(key);value.validate();return value.map.get(key)??null;}
  setItem(key,item){
    const value=brand(this);required(2,arguments.length);key=text(key);item=text(item);value.validate();
    value.map.set(key,item);value.sync([...value.map],{type:'set',key,value:item});
  }
  removeItem(key){
    const value=brand(this);required(1,arguments.length);key=text(key);value.validate();
    value.map.delete(key);value.sync([...value.map],{type:'remove',key});
  }
  clear(){const value=state(this);value.map.clear();value.sync([],{type:'clear'});}
  _get_entries(){return storage_entries(this);}
  _replace_entries(entries){replace_storage_entries(this,entries);}
  toString(){return '[object Storage]';}
  get [Symbol.toStringTag](){return 'Storage';}
}

export function install_storage_prototype(Storage){
  if(!Storage)return;
  const prototype=Storage.prototype,native=Object.getOwnPropertyDescriptors(prototype);
  const invoke=(name,receiver,args)=>Reflect.apply(lookup(receiver)?FakeStorage.prototype[name]:native[name].value,receiver,args);
  const methods={
    key(index){return invoke('key',this,arguments);},
    getItem(key){return invoke('getItem',this,arguments);},
    setItem(key,value){return invoke('setItem',this,arguments);},
    removeItem(key){return invoke('removeItem',this,arguments);},
    clear(){return invoke('clear',this,arguments);}
  };
  for(const [key,value] of Object.entries(methods))Object.defineProperty(prototype,key,{...native[key],value});
  const length=Object.getOwnPropertyDescriptor({get length(){
    return lookup(this)?state(this).map.size:Reflect.apply(native.length.get,this,[]);
  }},'length');
  Object.defineProperty(prototype,'length',{...native.length,get:length.get});
  // Native Storage ignores data-property attributes. Normalize before entering
  // Proxy [[DefineOwnProperty]], whose non-configurable invariants differ.
  const object_methods={
    defineProperty(object,key,descriptor){
      if(!lookup(object))return native_define(object,key,descriptor);
      if(!define(object,key,descriptor))throw new TypeError('Storage accessors are not supported');return object;
    },
    defineProperties(object,descriptors){
      if(!lookup(object))return native_defines(object,descriptors);
      const converted={};native_defines(converted,descriptors);
      for(const key of Reflect.ownKeys(converted))if(!define(object,key,native_descriptor(converted,key)))throw new TypeError('Storage accessors are not supported');return object;
    },
    keys(object){
      if(!lookup(object))return original_keys(object);
      const value=state(object);
      // Chromium's Storage key enumeration includes hidden writable names,
      // whereas descriptors and Object.entries use named-property visibility.
      const keys=[...value.map.keys(),...Reflect.ownKeys(value.target).filter(key=>typeof key==='string'&&!value.map.has(key))];
      return keys.filter(key=>{
        const own=native_descriptor(value.target,key);if(own)return own.enumerable;
        const descriptor=inherited(object,key);return !descriptor||descriptor.writable||descriptor.set;
      });
    }
  };
  const original_keys=Object.keys;
  for(const [key,value] of Object.entries(object_methods))native_define(Object,key,{...native_descriptor(Object,key),value});
  const defineProperty={defineProperty(object,key,descriptor){return lookup(object)?define(object,key,descriptor,true):native_reflect_define(object,key,descriptor);}}.defineProperty;
  native_define(Reflect,'defineProperty',{...native_descriptor(Reflect,'defineProperty'),value:defineProperty});
}
