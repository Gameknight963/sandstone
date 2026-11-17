import {unwrap_document,wrap_document} from '../document_identity.mjs';
import {unwrap_global_target} from '../global_functions.mjs';

const NativeRange=globalThis.Range,NativeStaticRange=globalThis.StaticRange;
const ranges=new WeakMap(),selections=new WeakMap();
const owner=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'ownerDocument').get;
const kind=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'nodeType').get;
const parent=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'parentNode').get;
const local=globalThis.Element&&Object.getOwnPropertyDescriptor(Element.prototype,'localName').get;
function descriptor(prototype,key){while(prototype){const property=Object.getOwnPropertyDescriptor(prototype,key);if(property)return {prototype,property};prototype=Object.getPrototypeOf(prototype);}}
const start=NativeRange&&descriptor(NativeRange.prototype,'startContainer').property.get;
const end=NativeRange&&descriptor(NativeRange.prototype,'endContainer').property.get;
const common=NativeRange&&descriptor(NativeRange.prototype,'commonAncestorContainer').property.get;
const startOffset=NativeRange&&descriptor(NativeRange.prototype,'startOffset').property.get;
const endOffset=NativeRange&&descriptor(NativeRange.prototype,'endOffset').property.get;
const collapsed=NativeRange&&descriptor(NativeRange.prototype,'collapsed').property.get;
export function range_points(range){return {common:common.call(range),start:start.call(range),end:end.call(range),startOffset:startOffset.call(range),endOffset:endOffset.call(range),collapsed:collapsed.call(range)};}
export function range_sources(range){
  // A cross-branch deletion can leave a modified style at either boundary,
  // even when its common ancestor is outside both stylesheets.
  const style=node=>node&&kind.call(node)===1&&local.call(node)==='style';
  return [common.call(range),...[start.call(range),end.call(range)].filter(node=>style(node)||style(parent.call(node)))];
}
const node_document=node=>kind.call(node)===9?node:owner.call(node);
const mapped=(state,node)=>state&&node===globalThis.document?state.alias:node;
function track(range,alias){
  if(range&&!ranges.has(range)){const document=node_document(start.call(range));ranges.set(range,{owner:document,alias:alias||wrap_document(globalThis.document)});}
  return range;
}
function update(range,args,positions){
  const state=ranges.get(range);if(!state)return;
  const document=node_document(start.call(range));
  if(state.owner!==document){state.owner=document;state.alias=wrap_document(document);}
  for(const index of positions)if(unwrap_document(args[index])===document)state.alias=args[index];
}
function constructor(Native,convert){
  if(!Native)return undefined;
  const wrapped=new Proxy(Native,{construct(target,args,newTarget){
    const state={alias:wrap_document(globalThis.document)},converted=convert?convert(args,state):args;
    return track(Reflect.construct(target,converted,newTarget),state.alias);
  }});
  Object.defineProperty(Native.prototype,'constructor',{...Object.getOwnPropertyDescriptor(Native.prototype,'constructor'),value:wrapped});
  return wrapped;
}
export const Range=constructor(NativeRange);
export const StaticRange=constructor(NativeStaticRange,(args,state)=>{
  if(!args.length||args[0]===null||!['object','function'].includes(typeof args[0]))return args;
  const converted=[...args];
  // Let native Web IDL read dictionary members in its prescribed order, with
  // each authored getter retaining its original receiver and exceptions.
  const source=args[0];
  converted[0]=new Proxy({},{get(_target,key){
    const value=Reflect.get(source,key,source);
    if(key!=='startContainer'&&key!=='endContainer')return value;
    const node=unwrap_document(value);if(node===globalThis.document)state.alias=value;
    return node;
  }});
  return converted;
});
const nativeCreate=globalThis.Document?.prototype.createRange,nativeSelection=globalThis.Document?.prototype.getSelection;
export const createRange=nativeCreate&&new Proxy(nativeCreate,{apply(target,receiver,args){return track(Reflect.apply(target,unwrap_document(receiver),args),receiver);}});
export const getSelection=nativeSelection&&new Proxy(nativeSelection,{apply(target,receiver,args){
  const selection=Reflect.apply(target,unwrap_document(receiver),args);
  if(selection)selections.set(selection,{alias:receiver});return selection;
}});
if(NativeRange){
  Document.prototype.createRange=createRange;
  const patched=new Set();
  for(const Native of [NativeRange,NativeStaticRange])if(Native)for(const name of ['startContainer','endContainer','commonAncestorContainer']){
    const entry=descriptor(Native.prototype,name);if(!entry||patched.has(entry.property.get))continue;
    const {prototype,property}=entry,get=function(){const node=property.get.call(this);return mapped(ranges.get(this),node);};
    patched.add(property.get);patched.add(get);
    Object.defineProperty(prototype,name,{...property,get});
  }
  const methods={setStart:[0],setEnd:[0],setStartBefore:[0],setStartAfter:[0],setEndBefore:[0],setEndAfter:[0],selectNode:[0],selectNodeContents:[0]};
  for(const [name,positions] of Object.entries(methods)){
    const native=NativeRange.prototype[name];
    NativeRange.prototype[name]=new Proxy(native,{apply(target,receiver,args){
      const converted=[...args];for(const index of positions)if(index<args.length)converted[index]=unwrap_document(args[index]);
      const result=Reflect.apply(target,receiver,converted);update(receiver,args,positions);return result;
    }});
  }
  for(const name of ['comparePoint','isPointInRange','intersectsNode']){
    const native=NativeRange.prototype[name];
    NativeRange.prototype[name]=new Proxy(native,{apply(target,receiver,args){const converted=[...args];if(args.length)converted[0]=unwrap_document(args[0]);return Reflect.apply(target,receiver,converted);}});
  }
  const clone=NativeRange.prototype.cloneRange;
  NativeRange.prototype.cloneRange=new Proxy(clone,{apply(target,receiver,args){const result=Reflect.apply(target,receiver,args),state=ranges.get(receiver);return state?track(result,state.alias):result;}});
}
if(globalThis.Selection){
  if(getSelection)Document.prototype.getSelection=getSelection;
  const windowSelection=globalThis.getSelection;
  if(windowSelection)globalThis.getSelection=new Proxy(windowSelection,{apply(target,receiver,args){
    const selection=Reflect.apply(target,unwrap_global_target(receiver),args);
    if(selection)selections.set(selection,{alias:wrap_document(globalThis.document)});return selection;
  }});
  for(const name of ['anchorNode','focusNode']){
    const property=Object.getOwnPropertyDescriptor(Selection.prototype,name);
    Object.defineProperty(Selection.prototype,name,{...property,get(){const node=property.get.call(this);return mapped(selections.get(this),node);}});
  }
  const getRange=Selection.prototype.getRangeAt;
  Selection.prototype.getRangeAt=new Proxy(getRange,{apply(target,receiver,args){const range=Reflect.apply(target,receiver,args);return track(range,selections.get(receiver)?.alias||wrap_document(globalThis.document));}});
  const addRange=Selection.prototype.addRange;
  Selection.prototype.addRange=new Proxy(addRange,{apply(target,receiver,args){
    const result=Reflect.apply(target,receiver,args);
    try{if(getRange.call(receiver,0)===args[0]&&ranges.has(args[0]))selections.set(receiver,{alias:ranges.get(args[0]).alias});}catch{}
    return result;
  }});
  const methods={collapse:[0],setPosition:[0],extend:[0],setBaseAndExtent:[0,2],selectAllChildren:[0],containsNode:[0]};
  for(const [name,positions] of Object.entries(methods)){
    const native=Selection.prototype[name];if(!native)continue;
    Selection.prototype[name]=new Proxy(native,{apply(target,receiver,args){
      const converted=[...args];for(const index of positions)if(index<args.length)converted[index]=unwrap_document(args[index]);
      const result=Reflect.apply(target,receiver,converted);
      if(name!=='containsNode')for(const index of positions)if(converted[index]===globalThis.document)selections.set(receiver,{alias:args[index]});
      return result;
    }});
  }
  const composed=Selection.prototype.getComposedRanges;
  if(composed)Selection.prototype.getComposedRanges=new Proxy(composed,{apply(target,receiver,args){const list=Reflect.apply(target,receiver,args),alias=selections.get(receiver)?.alias||wrap_document(globalThis.document);for(const range of list)track(range,alias);return list;}});
}
