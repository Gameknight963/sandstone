import {create_bootstrap_nonce} from '../bootstrap.mjs';

// Keep classic Script evaluation native: a per-realm global slot avoids
// wrapping programs or reserving fixed identifiers in authored lexical scopes.
export const runtime_context_name='__sandstone_context_'+create_bootstrap_nonce();
let context;
const document_realm=!!globalThis.Document&&!!globalThis.document;
export function install_runtime_context(value,helpers=value){
  if(!context){
    Object.defineProperty(globalThis,runtime_context_name,{value:helpers});
    context=value;
  }
}
export function get_runtime_context(){
  // A JavaScript string result can replace the Document while retaining this
  // Window. Do not publish the previous document's view before loader refresh.
  if(document_realm&&document!==globalThis.document)return undefined;
  return context;
}
export function window_runtime_context(target){
  try{return target.sandstone_frame?.context.get_runtime_context();}catch{}
}
export function window_runtime_value(target,key){
  const context=window_runtime_context(target);
  if(context)return context[key];
  // Provisional Windows must not supply pristine native networking globals.
  if(['closed','length','focus','blur','close'].includes(key)||key===Symbol.toStringTag)return target[key];
  if(key==='then')return undefined;
  target.document; // Preserve native cross-origin access errors.
  return key==='name'?target.name:undefined;
}
export function window_runtime_accessor(target,key){
  const context=window_runtime_context(target);
  if(!context)return window_runtime_value(target,key);
  const view=target.sandstone_frame.context.ctx;
  // Borrowed platform getters observe their native slot, even when the page
  // has installed an own-property override on its Window view.
  return key in view?Reflect.get(view,key,view):context[key];
}
