import {stringify_function,apply_function} from '../native_function_source.mjs';
import {function_sources} from '../function_sources.mjs';
import {document_states} from '../document_identity.mjs';

const dynamic_sources=document_states('dynamic-function-sources');
Function.prototype.__toString = stringify_function;
Function.prototype.toString = new Proxy(stringify_function,{apply(target,receiver,args){
  const js=apply_function(target,receiver,args);
  return dynamic_sources.has(receiver)?dynamic_sources.get(receiver):function_sources.original(js)??js;
}});
