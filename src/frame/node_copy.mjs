import {with_dom_access} from './dom_operations.mjs';
import {remember_shadow_root} from './shadow_roots.mjs';

const N=globalThis.Node?.prototype,E=globalThis.Element?.prototype;
const kind=N&&Object.getOwnPropertyDescriptor(N,'nodeType').get,getRoot=N?.getRootNode;
const local=E&&Object.getOwnPropertyDescriptor(E,'localName').get,namespace=E&&Object.getOwnPropertyDescriptor(E,'namespaceURI').get;
const host=globalThis.ShadowRoot&&Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'host').get;
let active_copy;

// Reactions run before native copy operations return. Restore the complete
// detached copy at the constructor/virtual-this boundary, before authored
// fields and bodies can inspect its resources or cloned shadow state.
export function perform_node_copy(source,operation,restore){
  let restored;const sourceRoot=getRoot.call(source),previous=active_copy,scope={};active_copy=scope;
  try{return with_dom_access(element=>{
    if(restored||active_copy!==scope)return;
    let root;try{root=getRoot.call(element);}catch{return;}
    while(host&&kind.call(root)===11){let element;try{element=host.call(root);}catch{break;}remember_shadow_root(element,root);root=getRoot.call(element);}
    if(root===sourceRoot||kind.call(root)!==kind.call(source))return;
    if(kind.call(source)===1&&(local.call(source)!==local.call(root)||namespace.call(source)!==namespace.call(root)))return;
    restored=root;restore(root);
  },()=>{const copy=operation();return copy===restored?copy:restore(copy);});}
  finally{active_copy=previous;}
}
