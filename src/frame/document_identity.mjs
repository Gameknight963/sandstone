import {ctx} from './context.mjs';
import {unwrap_global_target} from './global_functions.mjs';

const local={targets:new WeakMap(),aliases:new WeakMap(),states:new Map()},registries=new Set([local]);
let active=local;
// The storage group has already checked both native accessibility and virtual
// origin. Never discover a document by reading properties of an author object.
export function register_document(group,alias){
  active=group.document_identity??={targets:new WeakMap(),aliases:new WeakMap(),states:new Map()};
  registries.add(active);
  active.targets.set(alias,globalThis.document);
  active.aliases.set(globalThis.document,alias);
}
export function register_document_metadata(alias,getters){
  active.metadata??=new WeakMap();active.metadata.set(alias,getters);
}
export function document_metadata_getter(alias,name){
  for(const registry of registries){const getters=registry.metadata?.get(alias);if(getters)return getters[name];}
}
export function document_states(name,{weak=true}={}){
  const map=registry=>{let result=registry.states.get(name);if(!result)registry.states.set(name,result=weak?new WeakMap():new Map());return result;};
  // Retain earlier registries for objects kept after navigation or removal.
  return {
    ...(weak?{}:{forEach(callback){for(const registry of registries)map(registry).forEach(callback);}}),
    get(key){for(const registry of registries){const values=map(registry);if(values.has(key))return values.get(key);}},
    next(key){
      // Order source records across both shared realms and retained documents.
      // A newly selected group may have a lower counter than an older group.
      let value=0;for(const registry of registries)value=Math.max(value,map(registry).get(key)||0);
      map(active).set(key,++value);return value;
    },
    has(key){for(const registry of registries)if(map(registry).has(key))return true;return false;},
    delete(key){let removed=false;for(const registry of registries)removed=map(registry).delete(key)||removed;return removed;},
    set(key,value){map(active).set(key,value);}
  };
}

// Only unwrap proxies registered by this runtime. Do not inspect author objects
// or change the browser's conversion and receiver checks for other arguments.
export function unwrap_document(value){
  return globalThis.document&&unwrap_global_target(value)===document?document:value;
}
// Opt in only for APIs whose adapters handle foreign documents. For example,
// document.write must still run through the destination realm's HTML rewriter.
export function unwrap_frame_document(value){
  for(const registry of registries)if(registry.targets.has(value))return registry.targets.get(value);
  return unwrap_document(value);
}
export function wrap_frame_document(value){
  for(const registry of registries)if(registry.aliases.has(value))return registry.aliases.get(value);
  return wrap_document(value);
}
export function wrap_document(value){return globalThis.document&&value===document?ctx.document:value;}
