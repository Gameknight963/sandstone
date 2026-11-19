const states=new WeakMap(),box=Object,create=Object.create,apply=Reflect.apply;
const has=Reflect.has,get=Reflect.get,set=Reflect.set,remove=Reflect.deleteProperty;
const unscopables=Symbol.unscopables;
const NativeProxy=Proxy,NativeTypeError=TypeError;

// Resolve an identifier through captured with objects before the virtual global.
// Calls retain the selected object while arguments run. Reads and writes
// resolve independently, including compound updates and a changing object.
export function create_with_scope(value,parent,context,globals=context){
  if(value===null||value===undefined)throw new NativeTypeError('Cannot convert undefined or null to object');
  const object=box(value),state={object,parent:states.get(parent),context};
  const target_for=(name,callee=false,fallback=globals)=>{
    for(let current=state;current;current=current.parent){
      const object=current.object;if(!has(object,name))continue;
      const hidden=get(object,unscopables,object);
      if(hidden!==null&&(typeof hidden==='object'||typeof hidden==='function')&&hidden[name])continue;
      return callee?{object,receiver:object}:object;
    }
    return callee?{object:fallback,receiver:undefined}:fallback;
  };
  const read=(target,name)=>get(target,name,target);
  const token={object,context,
    reference(name,strict,fallback=globals){
      return new NativeProxy(create(null),{
        get:(_,key)=>read(target_for(name,false,fallback),key),
        set:(_,key,value)=>{
          const target=target_for(name,false,fallback);return set(target,key,value,target);
        },
        deleteProperty:(_,key)=>remove(target_for(name,false,fallback),key)
      });
    },
    evaluation(name,fallback=globals){const {object,receiver}=target_for(name,true,fallback);return [read(object,name),receiver,receiver!==undefined];},
    callee(name,strict,fallback=globals){
      const {object,receiver}=target_for(name,true,fallback),value=read(object,name);
      return typeof value==='function'?new NativeProxy(value,{apply(fn,ignored,args){return apply(fn,receiver,args)}}):value;
    }
  };
  states.set(token,state);return token;
}
