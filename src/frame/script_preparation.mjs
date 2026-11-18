import {prime_inert_script} from './rewrite/script.mjs';
import {script_kind} from './script_types.mjs';
import {script_text as text} from './script_text.mjs';

const pending=new WeakMap(),maps=new WeakMap();
const E=globalThis.Element?.prototype,N=globalThis.Node?.prototype,A=globalThis.Attr?.prototype;
const attributes=E&&Object.getOwnPropertyDescriptor(E,'attributes').get;
const get=E?.getAttribute,remove=E?.removeAttributeNode,set=E?.setAttributeNodeNS;
const connected=N&&Object.getOwnPropertyDescriptor(N,'isConnected').get;
const attrOwner=A&&Object.getOwnPropertyDescriptor(A,'ownerElement').get;
let installed=false;

export function deferred_script(node){return pending.has(node);}
export function defer_script(node,prepare){
  install_hooks();
  // Suppress native execution without replacing authored attributes or Text
  // nodes. Logical preparation is still deferred until an eligible mutation.
  const original=[...attributes.call(node)];for(const attr of original)remove.call(node,attr);
  prime_inert_script(node);for(const attr of [...attributes.call(node)])remove.call(node,attr);
  for(const attr of original)set.call(node,attr);
  const state={observer:null};
  const execute=()=>{
    state.observer.takeRecords();
    if(!pending.has(node)||!connected.call(node)||script_kind(get.call(node,'type'),get.call(node,'language'))===null||get.call(node,'src')===null&&text(node)==='')return;
    state.observer.disconnect();pending.delete(node);delete node.__sandstone_execute__;
    prepare();return node.__sandstone_execute__?.();
  };
  state.observer=new MutationObserver(records=>notify_script_preparation(node,records));
  state.observer.observe(node,{attributes:true,childList:true});
  pending.set(node,state);maps.set(attributes.call(node),node);node.__sandstone_execute__=execute;
}
export function notify_script_preparation(node,records){
  const state=pending.get(node);if(!state||state.textDepth)return;
  records??=state.observer.takeRecords();
  if(records.some(record=>record.type==='childList'||record.type==='attributes'&&record.attributeName==='src'&&record.attributeNamespace===null))node.__sandstone_execute__();
}
function install_hooks(){
  if(installed)return;installed=true;
  for(const name of ['setAttribute','setAttributeNS','removeAttribute','removeAttributeNS','toggleAttribute','setAttributeNode','setAttributeNodeNS','removeAttributeNode']){
    const method=E[name];E[name]=new Proxy(method,{apply(target,receiver,args){const result=Reflect.apply(target,receiver,args);notify_script_preparation(receiver);return result;}});
  }
  for(const name of ['setNamedItem','setNamedItemNS','removeNamedItem','removeNamedItemNS']){
    const method=NamedNodeMap.prototype[name];NamedNodeMap.prototype[name]=new Proxy(method,{apply(target,receiver,args){const result=Reflect.apply(target,receiver,args);notify_script_preparation(maps.get(receiver));return result;}});
  }
  for(const [prototype,name] of [[HTMLScriptElement.prototype,'src'],[HTMLScriptElement.prototype,'text'],[HTMLScriptElement.prototype,'textContent'],[HTMLScriptElement.prototype,'innerText'],[A,'value'],[N,'nodeValue'],[N,'textContent']]){
    const property=Object.getOwnPropertyDescriptor(prototype,name);if(!property?.set)continue;
    Object.defineProperty(prototype,name,{...property,set:new Proxy(property.set,{apply(target,receiver,args){
      const state=pending.get(receiver),settingText=state&&(name==='text'||name==='textContent'||name==='innerText'),before=settingText?text(receiver):null;
      if(settingText)state.textDepth=(state.textDepth||0)+1;
      try{return Reflect.apply(target,receiver,args);}finally{
        if(settingText)state.textDepth--;
        if(settingText&&before===text(receiver))state.observer.takeRecords();
        else notify_script_preparation(receiver instanceof Attr?attrOwner.call(receiver):receiver);
      }
    }})});
  }
}
