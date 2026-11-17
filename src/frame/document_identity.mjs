import {ctx} from './context.mjs';
import {unwrap_global_target} from './global_functions.mjs';

// Only unwrap proxies registered by this runtime. Do not inspect author objects
// or change the browser's conversion and receiver checks for other arguments.
export function unwrap_document(value){
  return globalThis.document&&unwrap_global_target(value)===document?document:value;
}
export function wrap_document(value){return globalThis.document&&value===document?ctx.document:value;}
