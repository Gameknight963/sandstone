import {document_states} from './document_identity.mjs';
import {create_function_sources} from './rewrite/function_sources.mjs';

const random=globalThis.crypto?.getRandomValues?.bind(globalThis.crypto);
let sequence=0;
export const function_sources=create_function_sources(document_states('authored-function-sources',{weak:false}),()=>{
  const bytes=new Uint32Array(4);
  if(random)random(bytes);
  return Array.from(bytes,value=>value.toString(36)).join('_')+'_'+(++sequence);
});
