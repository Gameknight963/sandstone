import {native_frame_window} from './iframe_window.mjs';
import {shadow_root} from './shadow_roots.mjs';
import {on_document_change} from './active_document.mjs';

const states=new WeakMap(),shadowRoots=new WeakMap(),observed=new WeakSet();
const node=globalThis.Node&&Node.prototype;
const children=node&&Object.getOwnPropertyDescriptor(node,'childNodes').get;
const connected=node&&Object.getOwnPropertyDescriptor(node,'isConnected').get;
const owner=node&&Object.getOwnPropertyDescriptor(node,'ownerDocument').get;
const getRoot=node?.getRootNode;
let observer;
on_document_change((previous,next)=>()=>{if(observer){observer.disconnect();observe(next);}});
function observe(root){
  if(observed.has(root))return;
  observed.add(root);observer.observe(root,{childList:true,subtree:true});
}
function roots(element){
  let root=getRoot.call(element);
  while(globalThis.ShadowRoot&&root instanceof ShadowRoot){
    shadowRoots.set(root.host,root);observe(root);root=getRoot.call(root.host);
  }
}
function reconcile(element,state){
  const active=connected.call(element)&&owner.call(element)===document;
  const window=active?native_frame_window(element):null;
  if(state.connected&&(!active||window!==state.window)){
    state.connected=false;state.window=null;state.disconnect();
  }
  if(active)roots(element);
  if(active&&!state.connected){
    state.connected=true;state.window=window;state.connect();
  }
}
export function reconcile_iframes(node,seen=new WeakSet()){
  if(!globalThis.Node||!(node instanceof Node)||seen.has(node))return;
  seen.add(node);
  const state=states.get(node);
  if(state)reconcile(node,state);
  const shadow=shadowRoots.get(node)||(node instanceof Element?shadow_root(node):null);
  if(shadow)reconcile_iframes(shadow,seen);
  for(const child of children.call(node))reconcile_iframes(child,seen);
}
export function track_iframe(element,{connect,disconnect}){
  if(!observer){
    observer=new MutationObserver(records=>{
      const seen=new WeakSet();
      for(const record of records)for(const node of [...record.removedNodes,...record.addedNodes])reconcile_iframes(node,seen);
    });
    observe(document);
  }
  const state={connect,disconnect,connected:false,window:null};
  states.set(element,state);reconcile(element,state);
}
