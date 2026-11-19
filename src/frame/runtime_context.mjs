import {create_bootstrap_nonce} from '../bootstrap.mjs';

// Keep classic Script evaluation native: a per-realm global slot avoids
// wrapping programs or reserving fixed identifiers in authored lexical scopes.
export const runtime_context_name='__sandstone_context_'+create_bootstrap_nonce();
let context;
export function install_runtime_context(value,helpers=value){
  if(!context){
    Object.defineProperty(globalThis,runtime_context_name,{value:helpers});
    context=value;
  }
}
export function get_runtime_context(){return context;}
export function window_runtime_context(target){
  try{return target.sandstone_frame?.context.get_runtime_context();}catch{}
}
