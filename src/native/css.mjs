import {create_css_bridge} from './css_bridge.mjs';

const minimum_units=4096;
const minimum_resources=64;
let bridge,initializing,busy=false,failure;
const calls={scan:0,prepare:0,restore:0,restoreParts:0,apply:0,srcset:0,applySrcset:0};
export const native_css_status=()=>({ready:!!bridge,busy,failure,memory_bytes:bridge?.memory_bytes()||0,calls:{...calls},minimum_units,minimum_resources});
export const native_css_ready=()=>initializing||Promise.resolve(false);
export function initialize_native_css(bytes){
  if(initializing)return initializing;
  initializing=(async()=>{
    try{bridge=await create_css_bridge(bytes);return true;}
    catch(error){failure=String(error);return false;}
  })();
  return initializing;
}
function use(operation,length,run){
  if(!bridge||busy||length<minimum_units)return null;
  const current=bridge;busy=true;
  try{const result=run(current);calls[operation]++;return result;}
  catch(error){
    // A thrown supports callback must propagate once, not be retried in JS.
    // Discard an unwound native instance; all later calls retain the JS path.
    const callback=current.callback_error();bridge=null;
    if(callback){failure='CSS supports callback threw';throw callback.error;}
    failure=String(error);
    return null;
  }finally{busy=false;}
}
export function native_css_references(source){
  return typeof source==='string'?use('scan',source.length,core=>core.scan(source)):null;
}
export function native_prepare_css(source,prefix,supports){
  return typeof prefix==='string'?use('prepare',source.length,core=>core.prepare(source,prefix,supports)):null;
}
function string_markers(markers){
  if(!(markers instanceof Map))return false;
  for(const [key,value]of markers)if(typeof key!=='string'||typeof value!=='string')return false;
  return true;
}
export function native_restore_css(source,markers,edits_only,prefixes){
  if(!bridge||busy||typeof source!=='string'||source.length<minimum_units||!string_markers(markers))return null;
  return use('restore',source.length,core=>core.restoreWithPrefixes(source,markers,edits_only,prefixes));
}
export function native_restore_css_parts(parts,markers,prefixes){
  if(!bridge||busy||!Array.isArray(parts)||!parts.every(part=>typeof part==='string')||!string_markers(markers))return null;
  return use('restoreParts',parts.reduce((sum,part)=>sum+part.length,0),core=>core.restoreParts(parts,markers,prefixes));
}
export function native_apply_css(source,references,values){
  if(!bridge||busy||source.length<minimum_units||references.length<minimum_resources||!values.every(value=>typeof value==='string'))return null;
  return use('apply',source.length,core=>core.apply(source,values,references.map(reference=>!!reference.supported)));
}
export function native_srcset_urls(source){return use('srcset',source.length,core=>core.srcset(source));}
export function native_rewrite_srcset(source,values){
  if(!bridge||busy||values.length<minimum_resources||!values.every(value=>typeof value==='string'))return null;
  return use('applySrcset',source.length,core=>core.applySrcset(source,values));
}
