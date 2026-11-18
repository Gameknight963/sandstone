import {rewrite_script,prime_inert_script} from './rewrite/script.mjs';
import * as loader from './loader.mjs';
import {svg_script_kind} from './script_types.mjs';

const states=new WeakMap(),primed=new WeakSet(),parser_scripts=new WeakSet(),animated=new WeakMap(),maps=new WeakMap();
const E=globalThis.Element?.prototype,N=globalThis.Node?.prototype,A=globalThis.Attr?.prototype;
const get=E?.getAttribute,getNS=E?.getAttributeNS,remove=E?.removeAttributeNode,set=E?.setAttributeNodeNS;
const attrs=E&&Object.getOwnPropertyDescriptor(E,'attributes').get,owner=N&&Object.getOwnPropertyDescriptor(N,'ownerDocument').get;
const view=globalThis.Document&&Object.getOwnPropertyDescriptor(Document.prototype,'defaultView').get;
const connected=N&&Object.getOwnPropertyDescriptor(N,'isConnected').get;
const children=N&&Object.getOwnPropertyDescriptor(N,'childNodes').get;
const kind=N&&Object.getOwnPropertyDescriptor(N,'nodeType').get;
const data=globalThis.CharacterData&&Object.getOwnPropertyDescriptor(CharacterData.prototype,'data').get;
const attrOwner=A&&Object.getOwnPropertyDescriptor(A,'ownerElement').get;
const href=globalThis.SVGScriptElement&&Object.getOwnPropertyDescriptor(SVGScriptElement.prototype,'href')?.get;
let inert,hooks=false;
export const is_svg_script=node=>!!globalThis.SVGScriptElement&&node instanceof SVGScriptElement;
const source=node=>get.call(node,'href')??getNS.call(node,'http://www.w3.org/1999/xlink','href');
const script_text=node=>[...children.call(node)].filter(child=>[3,4].includes(kind.call(child))).map(child=>data.call(child)).join('');
function eligible(node){return source(node)!==null||script_text(node).length>0;}
function prime(node){
  if(primed.has(node))return;
  // New active SVG scripts are primed before authors can assign their URLs.
  // Keep the same Attr objects when preparing an existing detached script.
  const original=[...attrs.call(node)];for(const attr of original)remove.call(node,attr);
  prime_inert_script(node);for(const attr of [...attrs.call(node)])remove.call(node,attr);
  for(const attr of original)set.call(node,attr);primed.add(node);
}
export function mark_svg_parser_script(node){if(eligible(node)&&svg_script_kind(get.call(node,'type'))!==null)parser_scripts.add(node);if(node.__rewritten__)primed.add(node);}
export function mark_svg_script_connected(node){
  if(!connected.call(node)||!eligible(node))return;
  const state=states.get(node);
  if(state)state.copiedStarted=true;
  else if(!view.call(owner.call(node))||node.__rewritten__){node.__sandstone_inert__=true;primed.add(node);}
}
export function capture_svg_script(node){
  const state=states.get(node),started=parser_scripts.has(node)||node.__sandstone_inert__||state&&(state.started||state.copiedStarted||connected.call(node)&&eligible(node)&&svg_script_kind(get.call(node,'type'))!==null);
  return copy=>{if(started)copy.__sandstone_inert__=true;if(primed.has(node))primed.add(copy);};
}
export function notify_svg_script(node,records){
  const state=states.get(node);if(!state)return;
  records??=state.observer.takeRecords();
  if(records.some(record=>record.type==='childList'||record.type==='attributes'&&record.attributeName==='href'&&(record.attributeNamespace===null||record.attributeNamespace==='http://www.w3.org/1999/xlink')))node.__sandstone_execute__();
}
export function rewrite_svg_script(node,options={}){
  let state=states.get(node);if(state)return state.pending;
  install_hooks();
  prime(node);state={prepared:false,copiedStarted:false};states.set(node,state);
  animated.set(href.call(node),node);maps.set(attrs.call(node),node);
  const prepare=()=>{
    if(state.prepared||!connected.call(node)||!eligible(node))return;
    state.prepared=true;
    if(!loader.site_settings.allow_js||node.__sandstone_inert__||svg_script_kind(get.call(node,'type'))===null)return;
    state.started=true;
    inert??=document.implementation.createHTMLDocument('');
    const script=inert.createElement('script');
    for(const name of ['type','crossorigin','referrerpolicy','async']){const value=get.call(node,name);if(value!==null)script.setAttribute(name,value);}
    const url=source(node);if(url!==null)script.setAttribute('src',url);script.textContent=script_text(node);
    Object.defineProperty(script,'isConnected',{get:()=>connected.call(node)});state.script=script;
    state.pending=rewrite_script(script,{...options,sourceElement:node});
  };
  node.__sandstone_execute__=()=>{state.observer.takeRecords();prepare();return state.script?.__sandstone_execute__?.();};
  state.observer=new MutationObserver(records=>notify_svg_script(node,records));
  state.observer.observe(node,{attributes:true,childList:true});
  if(options.parser)prepare();return state.pending;
}

// Run after native conversion/mutation so borrowed receivers, coercion order,
// Attr identity and SVGAnimatedString reflection keep their platform behavior.
function install_hooks(){
  if(hooks||!E||!globalThis.SVGScriptElement)return;hooks=true;
  for(const name of ['setAttribute','setAttributeNS','removeAttribute','removeAttributeNS','toggleAttribute','setAttributeNode','setAttributeNodeNS','removeAttributeNode']){
    const method=E[name];E[name]=new Proxy(method,{apply(target,receiver,args){const result=Reflect.apply(target,receiver,args);notify_svg_script(receiver);return result;}});
  }
  for(const name of ['setNamedItem','setNamedItemNS','removeNamedItem','removeNamedItemNS']){
    const method=NamedNodeMap.prototype[name];NamedNodeMap.prototype[name]=new Proxy(method,{apply(target,receiver,args){const result=Reflect.apply(target,receiver,args);notify_svg_script(maps.get(receiver));return result;}});
  }
  const base=Object.getOwnPropertyDescriptor(SVGAnimatedString.prototype,'baseVal');
  Object.defineProperty(SVGAnimatedString.prototype,'baseVal',{...base,set:new Proxy(base.set,{apply(target,receiver,args){const result=Reflect.apply(target,receiver,args);const node=animated.get(receiver);if(node)node.__sandstone_execute__();return result;}})});
  for(const [prototype,name] of [[A,'value'],[N,'nodeValue'],[N,'textContent']]){
    const property=Object.getOwnPropertyDescriptor(prototype,name);
    Object.defineProperty(prototype,name,{...property,set:new Proxy(property.set,{apply(target,receiver,args){const result=Reflect.apply(target,receiver,args);if(receiver instanceof Attr)notify_svg_script(attrOwner.call(receiver));return result;}})});
  }
}
