const NativeObject=Object,NativeSymbol=Symbol;
const {create,defineProperty,getOwnPropertyDescriptor,preventExtensions,freeze,is,getPrototypeOf}=Object;
const {get,ownKeys}=Reflect;

// A bundled namespace needs live getters, but its observable descriptors are
// data properties. Native namespaces reject writes and freezing even though
// those descriptors report writable:true.
export function create_module_namespace(value){
  const target=create(null),keys=ownKeys(value).filter(key=>typeof key==='string').sort();
  for(const key of keys)defineProperty(target,key,{value:undefined,writable:true,enumerable:true,configurable:false});
  defineProperty(target,NativeSymbol.toStringTag,{value:'Module'});
  preventExtensions(target);
  return new Proxy(target,{
    ownKeys:()=>ownKeys(target),
    get:(_,key)=>key===NativeSymbol.toStringTag?'Module':get(value,key,value),
    getOwnPropertyDescriptor:(_,key)=>{
      const descriptor=getOwnPropertyDescriptor(target,key);
      return descriptor&&typeof key==='string'?{...descriptor,value:get(value,key,value)}:descriptor;
    },
    set:()=>false,
    deleteProperty:(_,key)=>!getOwnPropertyDescriptor(target,key),
    defineProperty:(_,key,descriptor)=>{
      if(typeof key!=='string')return Reflect.defineProperty(target,key,descriptor);
      if(!getOwnPropertyDescriptor(target,key)||'get'in descriptor||'set'in descriptor||descriptor.configurable||descriptor.enumerable===false||descriptor.writable===false)return false;
      return !('value'in descriptor)||is(descriptor.value,get(value,key,value));
    }
  });
}

export const worker_module_intrinsics=freeze({
  setName(value,name){
    const descriptor=getOwnPropertyDescriptor(value,'name');
    if(descriptor&&'value'in descriptor&&descriptor.configurable&&!descriptor.writable&&descriptor.value!==name)defineProperty(value,'name',{...descriptor,value:name});
    return value;
  },
  Object:new Proxy(NativeObject,{get(target,key){
    if(key==='freeze')return value=>value&&getPrototypeOf(value)===null&&value[NativeSymbol.toStringTag]==='Module'?create_module_namespace(value):freeze(value);
    return get(target,key,target);
  }}),
  Symbol:NativeSymbol
});
