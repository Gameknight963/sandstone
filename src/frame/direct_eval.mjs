const apply=Reflect.apply,NativeProxy=Proxy,create=Object.create,freeze=Object.freeze,define=Reflect.defineProperty,describe=Reflect.getOwnPropertyDescriptor;
const get=WeakMap.prototype.get,set=WeakMap.prototype.set,has=Set.prototype.has,add=Set.prototype.add,remove=Set.prototype.delete;
const NativeWeakMap=WeakMap,NativeSet=Set;
// Engines have shipped different handling of eval(...args). Retain that
// engine's direct/indirect behavior instead of changing it by removing spread.
const directSpread=(()=>{const __sandstone_eval_probe=1;try{return eval(...['__sandstone_eval_probe'])===1}catch{return false}})();

// Keep preparation separate from execution: only the native eval at the
// authored call site can retain this, arguments, private names and local cells.
export function create_direct_eval({native,virtual,rewrite,global=globalThis}){
  const scopes=new NativeWeakMap(),pending=[];
  return {
    scope(){const token=freeze(create(null));apply(set,scopes,[token,new NativeSet()]);return token;},
    declare(token,names){const bindings=apply(get,scopes,[token]);if(bindings)for(const name of names)apply(add,bindings,[name]);},
    reference(tokens,name,local,globals,erase){
      for(const token of tokens){const bindings=apply(get,scopes,[token]);if(bindings&&apply(has,bindings,[name]))return erase?new NativeProxy(local,{deleteProperty:()=>{const deleted=erase();if(deleted)apply(remove,bindings,[name]);return deleted;}}):local;}
      return globals;
    },
    name(fn){define(fn,'name',{value:'eval'});return fn;},
    physical(){const descriptor=describe(global,'eval');return !!descriptor&&'value'in descriptor&&descriptor.value===native;},
    binding(local,erase){return erase?new NativeProxy(local,{deleteProperty:()=>erase()}):local;},
    select([callee,receiver,objectBinding],physical){
      if(callee===native||callee===virtual){
        try{if(!physical||physical()===native)return true;}catch{}
      }
      pending.push({callee,receiver});return false;
    },
    custom(){const {callee,receiver}=pending.pop();return (...args)=>apply(callee,receiver,args);},
    prepare(args,context){
      const indirect=context.spread&&!directSpread;
      const scope=indirect?{...context,strict:false,global:true,locals:[],scopes:[],declarationScope:undefined,privateNames:[],evalAliasVisible:false,withToken:undefined}:context;
      const source=typeof args[0]==='string'?rewrite(args[0],scope):args[0];
      return context.spread?[source]:source;
    }
  };
}
