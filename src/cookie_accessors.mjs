// Runtime documents have opaque physical origins: their native cookie getter
// throws SecurityError while active and returns an empty string after removal.
// Keep that lifecycle check while routing known document aliases to the relay.
export function create_cookie_accessors(native){
  const own=new WeakMap(),registries=new Set([own]);
  const lookup=value=>{for(const registry of registries){const record=registry.get(value);if(record)return record;}};
  function active(record){
    try{Reflect.apply(record.native.get,record.target,[]);}
    catch(error){if(error.name!=='SecurityError')throw error;return true;}
    return false;
  }
  function invoke(operation,receiver,args){
    const record=lookup(receiver);
    if(!record)return Reflect.apply(native[operation],receiver,args);
    let text;
    if(operation==='set'){
      if(typeof args[0]==='symbol')throw new TypeError('Cannot convert a Symbol to a string');
      text=String(args[0]);
    }
    if(!active(record))return operation==='get'?'':undefined;
    try{if(operation==='get')return record.get();record.set(text);return undefined;}
    catch(error){if(error.name==='SecurityError')throw new DOMException(error.message,'SecurityError');throw error;}
  }
  return {
    is_active(receiver){const record=lookup(receiver);return !!record&&active(record);},
    descriptor:{...native,
      get:new Proxy(native.get,{apply(target,receiver,args){return invoke('get',receiver,args);}}),
      set:new Proxy(native.set,{apply(target,receiver,args){return invoke('set',receiver,args);}})
    },
    register(target,alias,api,registry=own){
      registries.add(registry);const record={target,native,...api};
      own.set(target,record);own.set(alias,record);registry.set(target,record);registry.set(alias,record);
    }
  };
}
