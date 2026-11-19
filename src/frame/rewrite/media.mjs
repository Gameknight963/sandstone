import { ctx, intercept_property } from "../context.mjs";
import * as network from "../network.mjs";
import { rewrite_srcset } from "../srcset.mjs";
import {register_media_attributes,render_media_attribute,render_internal_media_attribute,detach_media_attribute_node,media_placeholder,placeholder_media_attribute,raw_media_attribute} from '../media_attributes.mjs';
import {on_dom_construction,native_dom} from '../dom_operations.mjs';
import {listen_runtime,unlisten_runtime} from '../runtime_events.mjs';
import {get_document_encoding} from '../document_encoding.mjs';
import {encoding_parse_url} from '../../url_encoding.mjs';
import {begin_media_playback,cancel_media_playback,finish_media_playback,prepare_media_playback,pending_media_url,release_media_url,load_media_sources,load_native_media} from '../media_playback.mjs';

const prepared = new WeakMap();
const sessions = new WeakMap();
const source_loads = new WeakMap();
const source_error_events=new WeakSet();
const owner=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'ownerDocument').get;
const native_base=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'baseURI').get;
const view=globalThis.Document&&Object.getOwnPropertyDescriptor(Document.prototype,'defaultView').get;
const set=globalThis.Element?.prototype.setAttribute,remove_attribute=globalThis.Element?.prototype.removeAttribute;
const attr_owner=globalThis.Attr&&Object.getOwnPropertyDescriptor(Attr.prototype,'ownerElement').get;
const attr_value=globalThis.Attr&&Object.getOwnPropertyDescriptor(Attr.prototype,'value');
const dispatch=globalThis.EventTarget?.prototype.dispatchEvent;
const attribute=globalThis.Element?.prototype.getAttribute;
const media_current=globalThis.HTMLMediaElement&&Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentSrc').get;
const media_src=globalThis.HTMLMediaElement&&Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'src');
const media_network=globalThis.HTMLMediaElement&&Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'networkState');
const media_stream=globalThis.HTMLMediaElement&&Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'srcObject');
const can_play=globalThis.HTMLMediaElement?.prototype.canPlayType,match_media=globalThis.matchMedia;
let policy_observer;
const image_prototype=globalThis.HTMLImageElement?.prototype;
const image_properties=image_prototype&&Object.fromEntries(['src','srcset','currentSrc'].map(key=>[key,Object.getOwnPropertyDescriptor(image_prototype,key)]));
const well_formed=String.prototype.toWellFormed;
const native_media=[['HTMLImageElement',['src','srcset']],['HTMLVideoElement',['src','poster']],['HTMLAudioElement',['src']],['HTMLSourceElement',['src','srcset']],['HTMLInputElement',['src']],['HTMLTrackElement',['src']]].map(([name,keys])=>({prototype:globalThis[name]?.prototype,keys}));
const is_prototype=Object.prototype.isPrototypeOf;
function source_error(event){
  if(!event.isTrusted||source_error_events.has(event)||!(event.target instanceof HTMLSourceElement))return;
  const element=event.target,parent=element.parentElement,state=sessions.get(element)?.states.get('src');
  if(!(parent instanceof HTMLMediaElement)||!state||raw_media_attribute(element,'src')===media_placeholder)return;
  source_error_events.add(event);
  // Internal reselection must not report an already rejected candidate again.
  // Authored load() and source changes start a fresh native selection attempt.
  if(state.sourceError?.parent===parent&&state.sourceError.generation===state.generation)event.stopImmediatePropagation();
  else state.sourceError={parent,generation:state.generation};
}
listen_runtime(globalThis,'error',source_error,true);
on_dom_construction(element=>{
  if(prepared.has(element))return;
  const type=native_media.find(({prototype})=>prototype&&is_prototype.call(prototype,element));
  // Existing attributes on native copies are restored by the copying operation.
  // Fresh custom elements need their internal listeners before authored fields.
  if(!type||type.keys.some(key=>raw_media_attribute(element,key)!==null))return;
  const original=Object.getPrototypeOf(element);
  if(original!==type.prototype)Object.setPrototypeOf(element,type.prototype);
  try{rewrite_media(element);}finally{if(original!==type.prototype)Object.setPrototypeOf(element,original);}
});

function reflected_source(element,key,native){
  const session=sessions.get(element),value=session?.authored.get(key);
  if(value===null||value===undefined)return native;
  if(key==='srcset')return value;
  try{return encoding_parse_url(value,session.base(),get_document_encoding(owner.call(element))).href;}catch{return value;}
}
function reflected_current(element,native){
  const session=sessions.get(element);
  if(session?.selectedSource?.retained)return session.selectedSource.target;
  return native===media_placeholder?session?.previousCurrentSrc||'':network.known_urls[native]||session?.aliases.get(native)||native;
}
if(image_properties)for(const [key,property] of Object.entries(image_properties)){
  const descriptor={...property,get:new Proxy(property.get,{apply(target,receiver,args){
    const native=Reflect.apply(target,receiver,args);
    if(key==='currentSrc')return reflected_current(receiver,native);
    return reflected_source(receiver,key,native);
  }})};
  if(property.set)descriptor.set=new Proxy(property.set,{apply(target,receiver,args){
    if(!args.length)return Reflect.apply(target,receiver,args);
    property.get.call(receiver);
    // Web IDL rejects Symbols, and src is a USVString while srcset is DOMString.
    let value=`${args[0]}`;
    if(key==='src')value=well_formed?well_formed.call(value):value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g,part=>part.length===2?part:'\uFFFD');
    if(!sessions.has(receiver)){
      const original=Object.getPrototypeOf(receiver);
      if(original!==image_prototype)Object.setPrototypeOf(receiver,image_prototype);
      try{rewrite_media(receiver);}finally{if(original!==image_prototype)Object.setPrototypeOf(receiver,original);}
    }
    const session=sessions.get(receiver),state=session.states.get(key);
    if(!state){session.authored.set(key,value);return;}
    return state.update(value);
  }});
  Object.defineProperty(image_prototype,key,descriptor);
}

function request_element(element,key){
  if(!(element instanceof HTMLSourceElement))return element;
  const parent=element.parentElement;
  if(parent instanceof HTMLPictureElement&&key!=='src'){
    const image=[...parent.children].find(child=>child instanceof HTMLImageElement);
    if(image&&[...parent.children].indexOf(element)<[...parent.children].indexOf(image))return image;
  }
  return parent instanceof HTMLMediaElement&&key!=='srcset'?parent:null;
}
function cross_origin(element){
  let target=request_element(element);
  if(target instanceof HTMLTrackElement)target=target.parentElement;
  if(!(target instanceof HTMLImageElement||target instanceof HTMLMediaElement))return null;
  const value=attribute.call(target,'crossorigin');
  return value===null?null:value.toLowerCase()==='use-credentials'?'use-credentials':'anonymous';
}
function refresh_image_policy(element){
  const session=sessions.get(element),policy=cross_origin(element);
  if(!session||session.crossOrigin===policy)return;
  session.crossOrigin=policy;
  const targets=[element];
  if(element.parentElement instanceof HTMLPictureElement){
    for(const child of element.parentElement.children){if(child===element)break;if(child instanceof HTMLSourceElement)targets.push(child);}
  }
  for(const target of targets){
    const state=sessions.get(target);
    if(!state||target!==element&&state.crossOrigin===policy)continue;
    state.crossOrigin=policy;
    for(const [key,value] of state.authored)if(value!==null)state.states.get(key).update(value,state.active);
  }
}
function refresh_source(element,reload=false){
  const session=sessions.get(element);if(!session)return;
  for(const [key,value] of session.authored){
    const state=session.states.get(key),target=request_element(element,key);
    if(value!==null&&(state.waiting?!!target:state.requestElement!==target||reload&&state.job?.cancelled))state.update(value,session.active);
  }
}
function observe_policy(element,options){
  policy_observer??=new MutationObserver(records=>{
    const sources=new Set();
    for(const record of records){
      if(record.type==='attributes')refresh_image_policy(record.target);
      else{
        const parent=record.target;
        if(parent instanceof HTMLMediaElement){
          const added=new Set(record.addedNodes);
          for(const node of record.removedNodes){
            const job=sessions.get(node)?.states.get('src')?.job;
            if(job?.parent===parent&&job.pending&&media_current.call(parent)===job.placeholder){
              job.examined=new Set([node]);
              for(const child of parent.childNodes){if(child===record.nextSibling)break;if(child instanceof HTMLSourceElement&&!added.has(child))job.examined.add(child);}
            }
          }
          const failed=sessions.get(parent)?.failedSource;
          if(failed)for(const node of added)failed.examined.delete(node);
        }
        for(const node of [...record.target.children,...record.removedNodes])if(node instanceof HTMLSourceElement)sources.add(node);
      }
    }
    for(const source of sources)refresh_source(source);
    for(const record of records){
      const failed=sessions.get(record.target)?.failedSource;
      if(failed)advance_retained_source(failed);
    }
  });
  policy_observer.observe(element,options);
}
export function observe_media_container(element){
  if(element instanceof HTMLPictureElement||element instanceof HTMLMediaElement)observe_policy(element,{childList:true});
  if(element instanceof HTMLMediaElement)prepare_media_playback(element,reason=>{
    if(reason==='load')reset_retained_sources(element);
    for(const source of element.children)if(source instanceof HTMLSourceElement){
      refresh_source(source,reason==='load');
      if(reason==='load'){
        const state=sessions.get(source)?.states.get('src');
        if(state){state.sourceError=null;state.resetPlaceholder?.();}
      }
    }
  });
}

function source_pending(element,placeholder,job) {
  const parent = element.parentElement;
  if (!(element instanceof HTMLSourceElement) || !(parent instanceof HTMLMediaElement)||sessions.get(parent)?.authored.get('src')!==null||media_stream.get.call(parent)!==null) return () => {};
  const state = source_loads.get(parent) || {revision: 0,placeholders:new Map(),jobs:new Set()};
  source_loads.set(parent, state);
  const token=begin_media_playback(parent,true);
  job.token=token;state.jobs.add(job);
  if(placeholder)state.placeholders.set(placeholder,job);
  const failed=sessions.get(parent)?.failedSource;
  if(failed)queueMicrotask(()=>advance_retained_source(failed));
  state.revision++;
  return () => {
    const revision = ++state.revision;
    queueMicrotask(() => {
      if(!job.retained)state.jobs.delete(job);
      if(job.cancelled||job.retained||job.epoch!==(sessions.get(parent)?.selectionGeneration||0)||state.revision!==revision||sessions.get(parent)?.authored.get('src')!==null||media_stream.get.call(parent)!==null)return;
      const current=media_current.call(parent),selected=state.placeholders.get(current);
      if(selected&&(selected.pending||selected.retained))return;
      // A delivered, selected source can play without waiting for an unused
      // fallback. Completing an unused candidate must not restart playback.
      if(current&&!selected&&current!==media_placeholder){state.placeholders.clear();return;}
      load_media_sources(parent,token);
    });
  };
}

function retain_selected_source(state){
  const job=state?.job;
  if(!job||!job.pending||job.cancelled||job.epoch!==(sessions.get(job.parent)?.selectionGeneration||0)||sessions.get(job.parent)?.authored.get('src')!==null||media_current.call(job.parent)!==job.placeholder)return false;
  if(!job.examined){
    job.examined=new Set([job.element]);
    if(job.element.parentElement===job.parent)for(const node of job.parent.children){job.examined.add(node);if(node===job.element)break;}
  }
  job.retained=true;sessions.get(job.parent).selectedSource=job;return true;
}
function reset_retained_sources(parent){
  const session=sessions.get(parent),group=source_loads.get(parent);
  if(session)session.selectionGeneration=(session.selectionGeneration||0)+1;
  if(session?.internalSource){
    if(raw_media_attribute(parent,'src')===session.internalSource)render_internal_media_attribute(parent,'src',null);
    session.internalSource=null;
  }
  for(const url of session?.retainedURLs||[]){release_media_url(url);delete network.known_urls[url];}
  if(session)session.retainedURLs=[];
  if(session){session.selectedSource=null;session.failedSource=null;}
  if(group)for(const job of group.jobs)if(job.retained||job.element.parentElement!==parent||session?.authored.get('src')!==null||media_stream.get.call(parent)!==null){job.cancelled=true;job.controller.abort();}
}
function probe_media(parent,url,signal){
  return new Promise((resolve,reject)=>{
    const decoder=native_dom.create.call(owner.call(parent),'http://www.w3.org/1999/xhtml',parent instanceof HTMLVideoElement?'video':'audio');
    const cleanup=()=>{
      unlisten_runtime(decoder,'loadedmetadata',success);unlisten_runtime(decoder,'error',failure);unlisten_runtime(signal,'abort',aborted);
      media_src.set.call(decoder,'');load_native_media(decoder);
    };
    const success=()=>{cleanup();resolve();},failure=()=>{cleanup();reject(new TypeError('Media cannot be decoded'));},aborted=()=>{cleanup();reject(signal.reason);};
    listen_runtime(decoder,'loadedmetadata',success);listen_runtime(decoder,'error',failure);listen_runtime(signal,'abort',aborted);
    if(signal.aborted){aborted();return;}
    decoder.preload='metadata';media_src.set.call(decoder,url);
  });
}
async function deliver_retained_source(job,url){
  const {parent,controller,token}=job,session=sessions.get(parent);
  await probe_media(parent,url,controller.signal);
  controller.signal.throwIfAborted();
  if(job.cancelled||session.selectedSource!==job||session.authored.get('src')!==null)return false;
  install_retained_url(job,url);return true;
}
function install_retained_url(job,url){
  const {parent,token}=job,session=sessions.get(parent);
  session.failedSource=null;session.aliases.set(url,job.target);
  session.internalSource=url;
  token.onLoadStart=()=>{
    if(raw_media_attribute(parent,'src')===session.internalSource&&media_src.get.call(parent)===media_current.call(parent))render_internal_media_attribute(parent,'src',null);
  };
  finish_media_playback(token);render_internal_media_attribute(parent,'src',url);
}
function fail_retained_source(job){
  const session=sessions.get(job.parent);
  if(job.cancelled||session.selectedSource!==job)return;
  session.failedSource=job;
  if(job.element.parentElement===job.parent)dispatch.call(job.element,new Event('error'));
  advance_retained_source(job);
}
function advance_retained_source(failed){
  const {parent}=failed,session=sessions.get(parent);
  if(failed.cancelled||session.failedSource!==failed||session.selectedSource!==failed)return;
  if(failed.exhausted&&failed.element.parentElement===parent)return;
  for(const element of parent.children){
    if(!(element instanceof HTMLSourceElement)||failed.examined.has(element))continue;
    failed.examined.add(element);
    const sourceSession=sessions.get(element),value=sourceSession?.authored.get('src'),type=attribute.call(element,'type'),media=attribute.call(element,'media');
    if(media&&!match_media.call(globalThis,media).matches)continue;
    if(!value||type&&!can_play.call(parent,type)){
      dispatch.call(element,new Event('error'));
      if(session.failedSource!==failed||failed.cancelled)return;
      continue;
    }
    session.failedSource=null;
    // A newly inserted candidate restarts selection after exhaustion. Its
    // loadstart is observable, unlike swaps within an ongoing selection.
    if(failed.exhausted)failed.token.loads=0;
    // Resolve a fallback with the policy, base URL and cookies at selection
    // time, rather than reusing an earlier speculative representation.
    sourceSession.states.get('src').update(value,true);
    const job=sourceSession.states.get('src').job;
    if(job){
      job.retained=true;job.examined=failed.examined;session.selectedSource=job;
      source_loads.get(parent).jobs.add(job);install_retained_url(job,job.placeholder);
    }else{
      const controller=new AbortController();
      let target;try{target=encoding_parse_url(value,sourceSession.base(),get_document_encoding(owner.call(element))).href;}catch{target=value;}
      const local={element,parent,controller,token:failed.token,retained:true,pending:false,cancelled:false,examined:failed.examined,target};
      session.selectedSource=local;source_loads.get(parent).jobs.add(local);
      deliver_retained_source(local,value).catch(()=>{if(!controller.signal.aborted)fail_retained_source(local);});
    }
    return;
  }
  failed.exhausted=true;
}

export function clone_media(source,copy,inactive=false){
  if(globalThis.Attr&&source instanceof Attr){
    const authored=prepared.get(attr_owner.call(source));
    if(source.namespaceURI===null&&authored?.has(source.localName)){attr_value.set.call(copy,authored.get(source.localName));return true;}
  }
  const authored=prepared.get(source);
  if(!authored)return false;
  if(inactive){for(const [key,value] of authored)if(value===null)remove_attribute.call(copy,key);else set.call(copy,key,value);}
  else rewrite_media(copy,authored);
  return true;
}
export function capture_media(source){
  if(globalThis.Attr&&source instanceof Attr){
    const authored=prepared.get(attr_owner.call(source));
    if(source.namespaceURI===null&&authored?.has(source.localName)){
      const value=authored.get(source.localName);return copy=>{attr_value.set.call(copy,value);return true;};
    }
  }
  const current=prepared.get(source);if(!current)return;
  const authored=new Map(current);
  return (copy,inactive=false)=>{
    if(inactive){for(const [key,value] of authored)if(value===null)remove_attribute.call(copy,key);else set.call(copy,key,value);}
    else rewrite_media(copy,authored);
    return true;
  };
}

export function detach_media_attribute(node){
  return detach_media_attribute_node(node);
}

export function set_media_active(element,active){
  const session=sessions.get(element);if(!session||session.active===active)return false;
  session.active=active;
  for(const [key,value] of session.authored)if(value!==null)session.states.get(key).update(value,active);
  return true;
}

export function rewrite_media(element,initial_sources) {
  if (prepared.has(element)) return;
  prepared.set(element,null);
  const get = element.getAttribute.bind(element);
  const properties = element instanceof HTMLImageElement?['src','srcset']:["src", "srcset", "poster"].filter(key => key in element);
  const authored = new Map(initial_sources||properties.map(key => [key, get(key)]));
  prepared.set(element,authored);
  const states = new Map();
  const base = () => owner.call(element)===document?ctx.document.baseURI:native_base.call(element);
  const aliases=new Map(),session={authored,states,active:true,crossOrigin:cross_origin(element),aliases,base};sessions.set(element,session);
  if(element instanceof HTMLImageElement)session.readCurrent=()=>image_properties.currentSrc.get.call(element);
  if(session.readCurrent)session.previousCurrentSrc=reflected_current(element,session.readCurrent());
  register_media_attributes(element,authored,(key,value)=>{
    const state=states.get(key);if(state)state.update(value);else authored.set(key,value);
  },key=>{
    const previous=authored.get(key);
    if(key==='src'&&previous===null&&session.internalSource)return;
    authored.set(key,null);
    if(key==='src'&&previous!==null)cancel_media_playback(element);
    const state=states.get(key);
    if(state){
      const retained=retain_selected_source(state);
      state.generation++;state.sourceError=null;state.pending=false;
      if(!retained){state.controller?.abort();state.release(state.urls);}
      state.urls=[];state.job=null;
    }
    render_media_attribute(element,key,null);
  },key=>states.get(key)?.pending);
  if(element instanceof HTMLImageElement){
    observe_policy(element,{attributes:true,attributeFilter:['crossorigin']});
  }
  observe_media_container(element);
  if(element instanceof HTMLSourceElement)observe_media_container(element.parentElement);
  // Retain native Attr identity while keeping remote URLs out of the renderer.
  for (const key of properties)render_media_attribute(element,key,key==='srcset'?'':media_placeholder);

  for (const key of properties) {
    const state = {generation: 0, urls: [], controller: null,waiting:false,requestElement:null,pending:false};
    states.set(key, state);
    const release = urls => {
      for (const url of urls) { release_media_url(url); delete network.known_urls[url]; }
    };
    let descriptor;
    function update(value,intended_active) {
      value = String(value);
      authored.set(key, value);
      const document=owner.call(element),active=intended_active??!!view.call(document);
      const request_base=active?ctx.document.baseURI:base();
      const request_encoding=get_document_encoding(active?globalThis.document:document);
      session.active=active;
      const retained=retain_selected_source(state);
      const generation = ++state.generation;
      state.sourceError=null;
      state.pending=true;
      if(!retained)state.controller?.abort();
      const controller = state.controller = new AbortController();
      state.job=null;
      if(session.readCurrent)session.previousCurrentSrc=reflected_current(element,session.readCurrent());
      let playback;
      if(key==='src'&&element instanceof HTMLMediaElement){
        reset_retained_sources(element);
        if(active&&value&&!/^(data|blob):/i.test(value))playback=begin_media_playback(element);
        else cancel_media_playback(element);
      }
      if(playback){
        let target;
        try{target=encoding_parse_url(value,request_base,request_encoding).href;}catch{target=value;}
        playback.onURL=url=>aliases.set(url,target);
        playback.onURL(playback.url);
      }
      render_media_attribute(element,key,playback?.url||(key==='srcset'?'':media_placeholder));
      if(!retained)release(state.urls);
      state.urls = [];
      const urls = [];
      const resources = new Map();
      let request_options;
      const source=element instanceof HTMLSourceElement;
      state.requestElement=request_element(element,key);
      state.waiting=active&&source&&!state.requestElement;
      const media_parent=key==='src'&&source&&state.requestElement instanceof HTMLMediaElement?state.requestElement:null;
      const remote=active&&value&&!/^(data|blob):/i.test(value);
      const placeholders=[];
      let target;try{target=encoding_parse_url(value,request_base,request_encoding).href;}catch{target=value;}
      const job=media_parent&&remote?{element,parent:media_parent,controller,pending:true,placeholder:null,retained:false,cancelled:false,target,epoch:sessions.get(media_parent)?.selectionGeneration||0}:null;
      state.job=job;
      state.resetPlaceholder=null;
      let placeholder;
      if(media_parent&&remote){
        const reset=()=>{
          if(!state.pending)return;
          const local=pending_media_url();if(!local)return;
          placeholder=local;state.urls.push(local);placeholders.push(local);
          job.placeholder=local;
          job.epoch=sessions.get(media_parent)?.selectionGeneration||0;
          let target;try{target=encoding_parse_url(value,request_base,request_encoding).href;}catch{target=value;}
          sessions.get(media_parent)?.aliases.set(local,target);
          source_loads.get(media_parent)?.placeholders.set(local,job);
          render_media_attribute(element,key,local);
        };
        state.resetPlaceholder=reset;reset();
      }
      const done=job?source_pending(element,placeholder,job):()=>{};
      // A source has no independent loader. Keep its authored URL virtual until
      // a picture image or media parent can supply the actual request context.
      if(state.waiting)return;
      const resource = async source => {
        if (!source) return source;
        const url = encoding_parse_url(source, request_base,request_encoding);
        if (["data:", "blob:"].includes(url.protocol)) return url.href;
        if (!resources.has(url.href)) resources.set(url.href, (async () => {
          const response = await network.fetch(url.href, request_options);
          if (!response.ok) throw new TypeError(`Media request failed: ${response.status}`);
          const blob = await response.blob();
          controller.signal.throwIfAborted();
          const local = network.create_blob_url(blob, url.href);
          aliases.set(local,url.href);
          if(media_parent)sessions.get(media_parent)?.aliases.set(local,url.href);
          urls.push(local);
          return local;
        })());
        return resources.get(url.href);
      };
      // Local sources retain their synchronous property behavior.
      if (!active || key !== "srcset" && (!value || /^(data|blob):/i.test(value))) {
        state.pending=false;
        descriptor.set.call(element, value);
        done();
        return;
      }
      (async () => {
        try {
          // Native resource selection waits until the current script finishes.
          // This includes CORS/referrer attributes assigned immediately after src.
          await Promise.resolve();
          controller.signal.throwIfAborted();
          state.requestElement=request_element(element,key);
          if(source&&!state.requestElement){state.waiting=true;return;}
          const crossOrigin=cross_origin(element);
          session.crossOrigin=crossOrigin;
          request_options={signal:controller.signal,credentials:crossOrigin==='anonymous'?'same-origin':'include',
            destination:key==='poster'||state.requestElement instanceof HTMLImageElement?'image':state.requestElement instanceof HTMLTrackElement?'track':state.requestElement instanceof HTMLVideoElement?'video':state.requestElement instanceof HTMLAudioElement?'audio':'image',
            mode:crossOrigin===null?state.requestElement instanceof HTMLTrackElement?'same-origin':'no-cors':'cors',referrerPolicy:state.requestElement.referrerPolicy};
          const rewritten = key === "srcset" ? await rewrite_srcset(value, async source => {
            try { return await resource(source); }
            catch (error) { if (controller.signal.aborted) throw error; return "data:application/octet-stream,failed"; }
          }) : await resource(value);
          if(job?.retained){
            if(await deliver_retained_source(job,rewritten)){
              const parentSession=sessions.get(media_parent);(parentSession.retainedURLs??=[]).push(...urls);
            }else release(urls);
            return;
          }
          if (generation !== state.generation) { release(urls); return; }
          state.urls = urls;
          finish_media_playback(playback);
          descriptor.set.call(element, rewritten);
        } catch (error) {
          release(urls);
          if(job?.retained){
            if(!job.cancelled&&!controller.signal.aborted)fail_retained_source(job);
            return;
          }
          if(generation===state.generation)state.pending=false;
          if (generation === state.generation && !controller.signal.aborted){
            if(playback){
              const failed='data:application/octet-stream,failed';
              playback.onURL(failed);finish_media_playback(playback);descriptor.set.call(element,failed);
            }
            else if(media_parent){
              let target;
              try{target=encoding_parse_url(value,request_base,request_encoding).href;}catch{target=value;}
              const failed=network.create_blob_url(new Blob(['invalid media'],{type:'application/octet-stream'}),target);
              state.urls=[failed];sessions.get(media_parent)?.aliases.set(failed,target);
              descriptor.set.call(element,failed);
            }else dispatch.call(element,new Event("error"));
          }
        } finally { release(placeholders);if(job)job.pending=false;if(generation===state.generation)state.pending=false;done(); }
      })();
    }
    descriptor = element instanceof HTMLImageElement?image_properties[key]:intercept_property(element, key, {
      get() {
        const value = authored.get(key);
        if (value === null || value === undefined) return key==='src'&&session.internalSource?'':descriptor.get.call(element);
        if (key === "srcset") return value;
        try { return encoding_parse_url(value, base(),get_document_encoding(owner.call(element))).href; } catch { return value; }
      },
      set: value=>update(value)
    });
    state.update = update;
    state.release = release;
  }

  if (!(element instanceof HTMLImageElement)&&"currentSrc" in element) {
    let current = intercept_property(element, "currentSrc", {
      get() {
        const value = current.get.call(element);
        return reflected_current(element,value);
      }
    });
    session.readCurrent=()=>current.get.call(element);
    session.previousCurrentSrc=reflected_current(element,session.readCurrent());
  }
  if(element instanceof HTMLMediaElement){
    intercept_property(element,'networkState',{get:()=>session.failedSource===session.selectedSource&&session.failedSource?3:media_network.get.call(element)});
    let stream=intercept_property(element,'srcObject',{
      get:()=>stream.get.call(element),
      set(value){
        const result=stream.set.call(element,value),current=stream.get.call(element);
        reset_retained_sources(element);cancel_media_playback(element);
        if(current===null)for(const source of element.children)if(source instanceof HTMLSourceElement){
          const sourceSession=sessions.get(source),state=sourceSession?.states.get('src'),value=sourceSession?.authored.get('src');
          if(value!==null&&value!==undefined&&(state.job?.cancelled||state.pending&&!state.job?.token))state.update(value,true);
          else if(state?.pending)state.resetPlaceholder?.();
        }
        return result;
      }
    });
  }
  // Removing a temporary source can produce a native empty-source error.
  listen_runtime(element,"error",event=>{
    if (!event.isTrusted||event.target!==element) return;
    source_error(event);
    if (!properties.every(key => authored.get(key)===null||placeholder_media_attribute(element,key))) return;
    // A picture source can be selected without an authored URL on the image.
    // Its real decode failure must still reach the page and document loader.
    if(element instanceof HTMLImageElement){
      const current=image_properties.currentSrc.get.call(element);
      if(current&&current!==media_placeholder)return;
    }
    if(element instanceof HTMLMediaElement){
      const current=media_current.call(element);
      if(current&&current!==media_placeholder)return;
    }
    event.stopImmediatePropagation();
  }, true);
  for (const [key, value] of authored) if (value !== null) states.get(key).update(value,true);
}
