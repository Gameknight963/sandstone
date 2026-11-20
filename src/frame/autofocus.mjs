import {ctx} from './context.mjs';
import * as loader from './loader.mjs';
import {document_states,unwrap_frame_document} from './document_identity.mjs';
import {listen_runtime} from './runtime_events.mjs';
import {on_shadow_root,shadow_root} from './shadow_roots.mjs';
import {pending_style_request} from './style_requests.mjs';
import {cookie_document_active} from './polyfill/cookie.mjs';

const document=globalThis.document,Observer=globalThis.MutationObserver,raf=globalThis.requestAnimationFrame;
const N=globalThis.Node?.prototype,E=globalThis.Element?.prototype,D=globalThis.Document?.prototype;
const get=(prototype,key)=>prototype&&Object.getOwnPropertyDescriptor(prototype,key)?.get;
const owner=get(N,'ownerDocument'),children=get(N,'childNodes'),connected=get(N,'isConnected'),kind=get(N,'nodeType');
const active=get(D,'activeElement'),body=get(D,'body'),html=get(D,'documentElement'),view=get(D,'defaultView');
const attribute=E?.getAttribute,byId=D?.getElementById,byName=D?.getElementsByName;
const htmlFocus=globalThis.HTMLElement?.prototype.focus,svgFocus=globalThis.SVGElement?.prototype.focus;
const namespace=get(E,'namespaceURI'),local=get(E,'localName');
const match=globalThis.matchMedia,linkDisabled=get(globalThis.HTMLLinkElement?.prototype,'disabled'),styleDisabled=get(globalThis.HTMLStyleElement?.prototype,'disabled');
const controllers=document_states('autofocus-controllers'),order=document_states('autofocus-order'),sequences=document_states('autofocus-elements');
const policy=document?.featurePolicy,allows=policy&&Object.getPrototypeOf(policy).allowsFeature;

function walk(node,callback){
  const pending=[node];
  while(pending.length){
    const current=pending.pop();callback(current);
    const descendants=[...children.call(current)];
    if(kind.call(current)===1){const root=shadow_root(current);if(root)descendants.push(root);}
    pending.push(...descendants.reverse());
  }
}
function fragment(doc,url){
  let id;try{id=new URL(url).hash.slice(1);if(!id)return false;try{id=decodeURIComponent(id);}catch{}}catch{return false;}
  return !!(byId.call(doc,id)||[...byName.call(doc,id)].some(element=>namespace.call(element)==='http://www.w3.org/1999/xhtml'&&local.call(element)==='a'));
}
function styles_pending(){
  let pending=false;
  walk(document,node=>{
    if(pending||kind.call(node)!==1||!pending_style_request(node))return;
    const tag=node.localName,disabled=tag==='link'?linkDisabled:tag==='style'?styleDisabled:null;
    try{if(disabled?.call(node))return;}catch{}
    const media=attribute.call(node,'media');if(media&&!match.call(globalThis,media).matches)return;
    pending=true;
  });return pending;
}
function controller(configuring=false){
  if(!document||!loader.is_loaded&&!configuring||loader.service_worker_host)return;
  let top;try{top=unwrap_frame_document(ctx.top.document);}catch{return;}
  let state=controllers.get(top);if(state)return state;
  // The virtual top-level document installs its scheduler before descendants
  // load, so retiring one child cannot strand the shared autofocus queue.
  if(top!==document)return;
  state={processed:false,scheduled:false,candidates:[],attempting:false,bodyFocused:false};
  state.schedule=()=>{
    if(state.scheduled||state.processed||!state.candidates.length)return;
    state.scheduled=true;raf.call(globalThis,()=>{
      state.scheduled=false;if(state.processed||!cookie_document_active(top))return;
      const focused=active.call(top);
      if(focused&&focused!==body.call(top)&&focused!==html.call(top)||state.bodyFocused||fragment(top,ctx.location.href)){
        state.processed=true;state.candidates=[];return;
      }
      state.candidates.sort((a,b)=>a.order-b.order);
      while(state.candidates.length){
        const entry=state.candidates[0];
        if(!entry.live()){state.candidates.shift();continue;}
        if(entry.styles()){state.schedule();return;}
        state.candidates.shift();if(entry.fragment())continue;
        state.attempting=true;
        try{entry.focus();}finally{state.attempting=false;}
        if(state.processed){state.candidates=[];return;}
      }
    });
  };
  controllers.set(top,state);return state;
}
// Only sequence preparation here. The observer below confirms actual insertion,
// including attributes removed by synchronous connected callbacks afterwards.
export function note_autofocus(element){
  if(attribute.call(element,'autofocus')===null)return;
  const state=controller();if(!state||state.processed)return;
  let top;try{top=unwrap_frame_document(ctx.top.document);}catch{return;}
  sequences.set(element,order.next(top));
}
export function configure_autofocus(){if(loader.service_worker_host)return;controller(true);install();}

let installed=false;
function install(){
  if(installed||!document||!Observer||!raf)return;installed=true;
  const seen=new WeakSet(),observer=new Observer(records=>{
    const state=controller();if(!state||state.processed||loader.automatic_features===false)return;
    if(allows&&!allows.call(policy,'focus-without-user-activation')&&!globalThis.navigator.userActivation?.isActive)return;
    const previous=new Map(),batches=[];
    // Reconstruct the attribute at insertion, rather than treating a later
    // autofocus assignment as a new candidate or discarding a removed flag.
    for(let index=records.length-1;index>=0;index--){
      const record=records[index];
      if(record.type==='attributes'){previous.set(record.target,record.oldValue);continue;}
      const batch=[];
      for(const node of record.addedNodes)walk(node,element=>{
        if(kind.call(element)!==1||owner.call(element)!==document)return;
        const value=previous.has(element)?previous.get(element):attribute.call(element,'autofocus');
        if(value!==null)batch.push(element);
      });batches.push(batch);
    }
    for(const batch of batches.reverse())for(const element of batch){
      state.candidates=state.candidates.filter(entry=>entry.element!==element);
      state.candidates.push({element,order:sequences.get(element)??order.next(unwrap_frame_document(ctx.top.document)),
        live:()=>connected.call(element)&&owner.call(element)===document&&cookie_document_active(document),
        styles:styles_pending,fragment:()=>fragment(document,ctx.location.href),
        focus:()=>{const ns=namespace.call(element),focus=ns==='http://www.w3.org/2000/svg'?svgFocus:ns==='http://www.w3.org/1999/xhtml'?htmlFocus:null;focus?.call(element);}
      });
    }
    state.schedule();
  });
  const observe=root=>{if(seen.has(root))return;seen.add(root);observer.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:['autofocus'],attributeOldValue:true});};
  observe(document);on_shadow_root(observe);
  listen_runtime(document,'focus',event=>{
    const state=controller();if(!state||!event.isTrusted)return;
    if(state.attempting){state.processed=true;return;}
    if(event.target===body.call(document)&&unwrap_frame_document(ctx.top.document)===document)state.bodyFocused=true;
  },true);
  listen_runtime(document,'blur',event=>{const state=controller();if(state&&event.target===body.call(document))state.bodyFocused=false;},true);
}
