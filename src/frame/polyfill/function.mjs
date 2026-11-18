import {ctx,ctx_vars} from '../context.mjs';
import * as loader from '../loader.mjs';
import {rewrite_dynamic_function} from '../rewrite/javascript.mjs';
import {document_states} from '../document_identity.mjs';
import {create_global_scope} from '../global_functions.mjs';

const Native=globalThis.Function,prototype=Native.prototype,stringify=prototype.toString;
const sources=document_states('dynamic-function-sources');
const nativeConstructors=[Native,Object.getPrototypeOf(async function(){}).constructor,Object.getPrototypeOf(function*(){}).constructor,Object.getPrototypeOf(async function*(){}).constructor];
const getPrototype=Object.getPrototypeOf,setPrototype=Object.setPrototypeOf,descriptor=Object.getOwnPropertyDescriptor,define=Object.defineProperty;
function compile(original){
  const source=Reflect.apply(stringify,original,[]),url=loader.url;
  const rewritten=rewrite_dynamic_function(source,ctx_vars,{url,sourceURL:url});
  const body=rewritten.needsScope?'with('+rewritten.scopeName+'){return '+rewritten.source+'\n}':'return '+rewritten.source;
  const factory=Reflect.apply(Native,undefined,[rewritten.contextName,rewritten.thisName,rewritten.scopeName,body]);
  const fn=Reflect.apply(factory,undefined,[ctx.__proxy__,(value,strict)=>ctx.__get_this__(value,strict),rewritten.needsScope?create_global_scope(ctx.__proxy__,ctx_vars):undefined]);
  setPrototype(fn,getPrototype(original));define(fn,'name',descriptor(original,'name'));
  sources.set(fn,source);return fn;
}
const constructors=nativeConstructors.map(target=>new Proxy(target,{
  // Native construction performs argument coercion and syntax validation once.
  apply(target,receiver,args){return compile(Reflect.apply(target,receiver,args));},
  construct(target,args,newTarget){return compile(Reflect.construct(target,args,newTarget));}
}));
export const Function=constructors[0];
// Keep the physical global constructor available to the runtime's blob importer.
// Authored code reaches these constructors through its virtual global/prototypes.
for(let index=0;index<nativeConstructors.length;index++){
  const target=nativeConstructors[index];
  define(target.prototype,'constructor',{...descriptor(target.prototype,'constructor'),value:constructors[index]});
  if(index)setPrototype(target,Function);
}
define(prototype,'toString',{...descriptor(prototype,'toString'),value:new Proxy(stringify,{apply(target,receiver,args){
  const native=Reflect.apply(target,receiver,args);return sources.has(receiver)?sources.get(receiver):native;
}})});
