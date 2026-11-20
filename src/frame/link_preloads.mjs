import * as network from './network.mjs';
import * as loader from './loader.mjs';
import {ctx} from './context.mjs';
import {encoding_parse_url} from '../url_encoding.mjs';
import {get_document_encoding} from './document_encoding.mjs';
import {document_referrer_policy} from './intercept/document.mjs';
import {schedule_resource_event} from './resource_events.mjs';
import {modules} from './polyfill/module.mjs';
import {native_dom} from './dom_operations.mjs';
import {mime_essence} from '../mime.mjs';
import {javascript_mime_essence} from './script_types.mjs';
const get=globalThis.Element?.prototype.getAttribute,connected=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'isConnected').get;
const schedule=globalThis.setTimeout,cancelTimer=globalThis.clearTimeout,Observer=globalThis.MutationObserver,dispatch=globalThis.EventTarget?.prototype.dispatchEvent,NativeEvent=globalThis.Event;
const destinations=new Set(['script','image','font','fetch']);

export function create_link_preload(element,href){
  let signature,current,cancelStart,eventTimer,watcher;
  const attached=()=>connected.call(element)&&native_dom.owner.call(element)===document;
  function cancel(){cancelStart?.();cancelStart=null;cancelTimer(eventTimer);eventTimer=null;watcher?.disconnect();watcher=null;current?.abort();current=null;signature=null;element.__sandstone_execute__=update;}
  function selection(){
    const relations=(get.call(element,'rel')||'').toLowerCase().split(/[\t\n\f\r ]+/),module=relations.includes('modulepreload'),as=(get.call(element,'as')||'').toLowerCase();
    if(!module&&(!relations.includes('preload')||!destinations.has(as))||module&&as&&as!=='script')return;
    const type=get.call(element,'type');if(type&&(module||as==='script')&&!javascript_mime_essence(mime_essence(type)))return;
    const source=href();if(!source)return;
    const media=get.call(element,'media');if(media&&!matchMedia(media).matches)return;
    let url;try{url=encoding_parse_url(source,ctx.document.baseURI,get_document_encoding(native_dom.owner.call(element))).href;}catch{return;}
    if(!/^(https?|data|blob):/.test(url))return;
    const cross=get.call(element,'crossorigin'),credentials=cross?.toLowerCase()==='use-credentials'?'include':module||cross!==null?'same-origin':'include';
    return {url,module,options:{destination:as==='fetch'?'':as||'script',mode:module||cross!==null?'cors':'no-cors',credentials,referrerPolicy:element.referrerPolicy||document_referrer_policy()}};
  }
  function start(){
    if(!attached()||!current||current.signal.aborted)return;
    cancelStart?.();cancelStart=null;const selected=selection();if(!selected)return;
    const controller=current;
    watcher=new Observer(()=>{if(!attached())cancel();});watcher.observe(document,{subtree:true,childList:true});
    const root=element.getRootNode();if(root!==document)watcher.observe(root,{subtree:true,childList:true});
    const emit=type=>{if(current!==controller||controller.signal.aborted)return;watcher?.disconnect();watcher=null;eventTimer=schedule(()=>{eventTimer=null;if(current===controller&&!controller.signal.aborted&&attached()){element.__sandstone_execute__=()=>{signature=null;update();};dispatch.call(element,new NativeEvent(type));}},0);};
    const pending=selected.module?modules.prepare_url(selected.url,ctx.document.baseURI,{credentials:selected.options.credentials,context:{referrer:ctx.location.href,referrerPolicy:selected.options.referrerPolicy}}):network.preload_resource(selected.url,{...selected.options,signal:controller.signal});
    Promise.resolve(pending).then(result=>emit(selected.module||result.status>=200&&result.status<300?'load':'error'),()=>emit('error'));
    // DOM insertion may revisit this node while a request is already pending.
    element.__sandstone_execute__=()=>{};
  }
  function update(){
    const selected=selection(),next=selected&&JSON.stringify(selected);if(next===signature)return;
    cancel();if(!selected)return;signature=next;current=new AbortController();element.__sandstone_execute__=start;
    cancelStart=schedule_resource_event(element,start);if(attached())start();
  }
  return {update,dispose(){cancel();delete element.__sandstone_execute__;}};
}
