// Retain native event objects and Web IDL conversion. Only the Storage slot
// needs an alias because the browser cannot brand the relay's storage views.
export function install_storage_events(NativeStorageEvent,is_storage,areas=new WeakMap()){
  const prototype=NativeStorageEvent.prototype;
  const area=Object.getOwnPropertyDescriptor(prototype,'storageArea');
  const init=Object.getOwnPropertyDescriptor(prototype,'initStorageEvent');
  const phase=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(prototype),'eventPhase').get;
  const getter=new Proxy(area.get,{apply(target,receiver,args){
    const native=Reflect.apply(target,receiver,args);
    return areas.has(receiver)?areas.get(receiver):native;
  }});
  Object.defineProperty(prototype,'storageArea',{...area,get:getter});
  Object.defineProperty(prototype,'initStorageEvent',{...init,value:new Proxy(init.value,{apply(target,receiver,args){
    const storage=args[7],virtual=is_storage(storage),converted=virtual?[...args]:args;
    if(virtual)converted[7]=null;
    const result=Reflect.apply(target,receiver,converted);
    // initEvent does nothing during dispatch, including its Storage slot.
    if(Reflect.apply(phase,receiver,[])===0){if(virtual)areas.set(receiver,storage);else areas.delete(receiver);}
    return result;
  }})});
  const StorageEvent=new Proxy(NativeStorageEvent,{construct(target,args,newTarget){
    const dictionary=args[1];let storage;
    if(dictionary!==null&&(typeof dictionary==='object'||typeof dictionary==='function')){
      args=[...args];
      // A separate proxy target also supports frozen dictionaries. Preserve
      // member order and getter receivers by letting native conversion read it.
      args[1]=new Proxy(Object.create(null),{get(_target,key){
        const value=Reflect.get(dictionary,key,dictionary);
        if(key==='storageArea'&&is_storage(value)){storage=value;return null;}
        return value;
      }});
    }
    const event=Reflect.construct(target,args,newTarget);
    if(storage)areas.set(event,storage);
    return event;
  }});
  Object.defineProperty(prototype,'constructor',{...Object.getOwnPropertyDescriptor(prototype,'constructor'),value:StorageEvent});
  return StorageEvent;
}
