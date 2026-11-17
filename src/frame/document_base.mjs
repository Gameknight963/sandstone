import {resolve_base_href} from '../base_url.mjs';

let fallbackSource,preloadSource,observer,first;
const frozen=new WeakMap();
const query=globalThis.Document?.prototype.querySelectorAll;
const get=globalThis.Element?.prototype.getAttribute;
const owner=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'ownerDocument').get;
export function configure_document_base(fallback,preload){fallbackSource=fallback;preloadSource=preload;}
function fallback_url(){try{return fallbackSource?.();}catch{return undefined;}}
export function flush_document_base(delivered=[]) {
  const fallback=fallback_url();if(!globalThis.document||!fallback)return;
  if(!observer){observer=new MutationObserver(records=>flush_document_base(records));observer.observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['href'],attributeOldValue:true});}
  const records=[...delivered,...observer.takeRecords()];
  const next=[...query.call(document,'base[href]')].find(node=>node instanceof HTMLBaseElement);
  const freeze=href=>frozen.set(next,resolve_base_href(href,fallback,frozen.get(next)||fallback));
  if(next!==first){first=next;if(next)freeze(get.call(next,'href'));}
  else if(next){
    const attributes=records.filter(record=>record.type==='attributes'&&record.target===next);
    for(let index=0;index<attributes.length;index++)freeze(index+1<attributes.length?attributes[index+1].oldValue:get.call(next,'href'));
    if(records.some(record=>record.type==='childList'&&[...record.addedNodes].some(node=>node===next||node.contains(next))))freeze(get.call(next,'href'));
  }
}
export function document_base_url(){
  flush_document_base();
  return preloadSource?.()||first&&frozen.get(first)||fallback_url();
}
export function mutate_document_base(operation){flush_document_base();try{return operation();}finally{flush_document_base();}}

if(globalThis.document){
  const property=Object.getOwnPropertyDescriptor(HTMLBaseElement.prototype,'href');
  Object.defineProperty(HTMLBaseElement.prototype,'href',{...property,
    get(){
      const native=property.get.call(this);if(owner.call(this)!==document)return native;
      const raw=get.call(this,'href'),fallback=fallback_url();if(!fallback)return native;
      if(raw===null)return fallback;
      try{return new URL(raw,fallback).href;}catch{return raw;}
    },
    set(value){return owner.call(this)===document?mutate_document_base(()=>property.set.call(this,value)):property.set.call(this,value);}
  });
  for(const key of ['setAttribute','setAttributeNS','removeAttribute','removeAttributeNS','toggleAttribute','setAttributeNode','setAttributeNodeNS','removeAttributeNode']){
    const original=Element.prototype[key];
    if(!original)continue;
    Element.prototype[key]=new Proxy(original,{apply(target,receiver,args){
      return receiver instanceof HTMLBaseElement&&owner.call(receiver)===document?mutate_document_base(()=>Reflect.apply(target,receiver,args)):Reflect.apply(target,receiver,args);
    }});
  }
  const baseURI=Object.getOwnPropertyDescriptor(Node.prototype,'baseURI');
  Object.defineProperty(Node.prototype,'baseURI',{...baseURI,get(){
    const native=baseURI.get.call(this);
    return this===document||owner.call(this)===document?document_base_url()||native:native;
  }});
}
