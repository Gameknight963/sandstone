import {HTMLDOMStream} from './html_dom_stream.mjs';
import {native_dom as dom} from './dom_operations.mjs';
import {listen_runtime,unlisten_runtime,snapshot_runtime_events,restore_runtime_events} from './runtime_events.mjs';
import {walk_resources,prepare_resources} from './resource_nodes.mjs';
import {forget_document_listeners} from './link_events.mjs';
import {unwrap_document,wrap_document} from './document_identity.mjs';
import {rewrite_script,prime_inert_script,mark_parser_script} from './rewrite/script.mjs';
import {rewrite_element} from './rewrite/element.mjs';
import {activate_parser_event_attributes} from './event_attributes.mjs';
import {reconcile_iframes} from './iframe_lifecycle.mjs';
import {flush_import_map} from './polyfill/module.mjs';
import {ctx} from './context.mjs';
import * as loader from './loader.mjs';
import {pending_media_attribute} from './media_attributes.mjs';
import {pending_style_request} from './style_requests.mjs';
import {is_svg_script} from './svg_scripts.mjs';
import {script_kind,svg_script_kind} from './script_types.mjs';
import {pending_script_loads,wait_script_loads} from './script_lifetime.mjs';

let session,writer,writerOwner,ignoreWrites=0,validation;
const completion_observers=new Set();
export function on_document_complete(callback){completion_observers.add(callback);return ()=>completion_observers.delete(callback);}
export function initialize_blank_document(){
  while(document.firstChild)dom.remove.call(document,document.firstChild);
  const html=dom.create.call(document,'http://www.w3.org/1999/xhtml','html');
  dom.append.call(html,dom.create.call(document,'http://www.w3.org/1999/xhtml','head'));
  dom.append.call(html,dom.create.call(document,'http://www.w3.org/1999/xhtml','body'));
  dom.append.call(document,html);loader.set_ready_state('complete');
}
const type=globalThis.Document&&Object.getOwnPropertyDescriptor(Document.prototype,'contentType').get;
const state=globalThis.Document&&Object.getOwnPropertyDescriptor(Document.prototype,'readyState').get;
const link_href=globalThis.HTMLLinkElement&&Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype,'href').get;
const link_sheet=globalThis.HTMLLinkElement&&Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype,'sheet').get;
export const input_ready_state=()=>session?.phase;
const strings=args=>args.map(value=>{if(typeof value==='symbol')throw new TypeError('Cannot convert a Symbol to a string');return String(value);}).join('');
function scoped(input,callback,owner){const previous=writer,previousOwner=writerOwner;writer=input;writerOwner=owner;try{return callback();}finally{writer=previous;writerOwner=previousOwner;}}
function ignored(callback){ignoreWrites++;try{return callback();}finally{ignoreWrites--;}}
function nodes(){const values=[globalThis];walk_resources(document,node=>values.push(node));return values;}
function emit(target,name){target.dispatchEvent(new Event(name,{bubbles:name==='DOMContentLoaded'}));}
function styles(current){
  const pending=[];
  walk_resources(document,node=>{
    const request=pending_style_request(node);if(!request&&!(node instanceof HTMLLinkElement))return;
    if(node.disabled||node.media&&!globalThis.matchMedia(node.media).matches)return;
    if(node instanceof HTMLLinkElement&&!Element.prototype.matches.call(node,'[rel~="stylesheet" i]'))return;
    const rendered=()=>{
      if(current.controller.signal.aborted||!(node instanceof HTMLLinkElement)||!node.isConnected||link_sheet.call(node)||!/^data:|^blob:/.test(link_href.call(node)))return;
      return new Promise(resolve=>{
        const done=()=>{unlisten_runtime(node,'load',done);unlisten_runtime(node,'error',done);current.controller.signal.removeEventListener('abort',done);resolve();};
        listen_runtime(node,'load',done);listen_runtime(node,'error',done);current.controller.signal.addEventListener('abort',done,{once:true});
      });
    };
    if(request)pending.push(Promise.resolve(request).then(rendered));
    else if(node instanceof HTMLLinkElement){const ready=rendered();if(ready)pending.push(ready);}
  });
  return pending;
}
function images(current){
  const pending=[];
  if(current.controller.signal.aborted)return pending;
  walk_resources(document,node=>{
    if(!(node instanceof HTMLImageElement)||node.loading==='lazy')return;
    const requested=()=>!!node.getAttribute('src')||!!node.getAttribute('srcset')||node.parentElement instanceof HTMLPictureElement&&!!node.parentElement.querySelector('source[srcset]');
    if(!requested())return;
    const waiting=()=>!!node.getAttribute('src')&&pending_media_attribute(node,'src')||!!node.getAttribute('srcset')&&pending_media_attribute(node,'srcset')||node.parentElement instanceof HTMLPictureElement&&[...node.parentElement.querySelectorAll('source[srcset]')].some(source=>!!source.getAttribute('srcset')&&pending_media_attribute(source,'srcset'));
    if(node.complete&&!waiting())return;
    pending.push(new Promise(resolve=>{
      const observer=new MutationObserver(()=>{if(!requested())cleanup();});
      const cleanup=()=>{observer.disconnect();unlisten_runtime(node,'load',loaded);unlisten_runtime(node,'error',loaded);current.controller.signal.removeEventListener('abort',cleanup);resolve();};
      // Error/load handlers can replace the source. Check after they run so a
      // fallback request still delays the document, while removal can settle
      // without waiting for a resource event that the browser never dispatches.
      const loaded=()=>queueMicrotask(()=>{if(!waiting())cleanup();});
      observer.observe(node,{attributes:true,attributeFilter:['src','srcset']});
      listen_runtime(node,'load',loaded);listen_runtime(node,'error',loaded);current.controller.signal.addEventListener('abort',cleanup,{once:true});
    }));
  });
  return pending;
}

async function wait_image_loads(current,pending=images(current)){
  // Load/error handlers and late scripts can create another image request.
  // Drain both queues until their handlers leave no outstanding work.
  do{
    await Promise.allSettled(pending);
    await wait_script_loads(current.controller.signal);
    if(current.controller.signal.aborted)return;
    pending=images(current);
  }while(pending.length||pending_script_loads());
}

function prepare_script(current,node,input){
  if(current.controller.signal.aborted||!loader.site_settings.allow_js)return;
  const svg=is_svg_script(node),kind=svg?svg_script_kind(node.getAttribute('type')):script_kind(node.getAttribute('type'),node.getAttribute('language')),module=kind==='module';
  const external=svg?node.hasAttribute('href')||node.hasAttributeNS('http://www.w3.org/1999/xlink','href'):node.hasAttribute('src');
  const deferred=module||!svg&&external&&node.hasAttribute('defer'),asynchronous=external&&node.hasAttribute('async');
  const run=callback=>deferred||asynchronous?ignored(callback):scoped(input,callback,current);
  const pending=rewrite_script(node,{parser:true,signal:current.controller.signal,run});
  const execute=()=>{
    if(current.controller.signal.aborted)return;
    flush_import_map();return module?run_late_script(()=>node.__sandstone_execute__?.()):node.__sandstone_execute__?.();
  };
  if(asynchronous){current.async.push(Promise.resolve(pending).then(execute));return;}
  if(deferred){current.deferred.push(()=>Promise.all([pending,...styles(current)]).then(execute));return;}
  const blocking=(kind==='classic'||kind==='module')&&node.__sandstone_execute__?styles(current):[];
  return pending||blocking.length?Promise.all([pending,...blocking]).then(execute):execute();
}
export function run_late_script(execute){
  ignoreWrites++;let result;try{result=execute();}catch(error){ignoreWrites--;throw error;}
  if(result&&typeof result.then==='function')return Promise.resolve(result).finally(()=>ignoreWrites--);
  ignoreWrites--;return result;
}
export function run_document_script(element,execute){return (is_svg_script(element)?element.hasAttribute('href')||element.hasAttributeNS('http://www.w3.org/1999/xlink','href'):element.hasAttribute('src'))&&!writer?ignored(execute):execute();}
export async function load_document_html(source,{scriptingEnabled=true}={}){
  const current=begin({source:true,scriptingEnabled});
  current.stream.write(source);close(current);await current.finished;
}
export async function load_document_xml(source,{scriptingEnabled=true}={}){
  // Parse without connecting nodes. Every resource must be rewritten before
  // adoption into the live XML document, where native loading can begin.
  const mime=type.call(document);
  // DOMParser's enum omits feed types even though native navigation supports
  // them. Parse their tree as generic XML; the live document retains its MIME.
  const parsed=new DOMParser().parseFromString(source,mime==='application/rss+xml'||mime==='application/atom+xml'?'application/xml':mime);
  session?.controller.abort(new DOMException('The document was replaced','AbortError'));
  const current={controller:new AbortController(),source:true,xml:true,phase:'loading',async:[],deferred:[],finished:null};session=current;
  loader.set_ready_state('loading');
  const pending=[];
  current.stream={closed:true,get pendingResources(){return pending.length;},finish:()=>Promise.resolve(),settled:()=>Promise.allSettled(pending)};
  while(document.firstChild)dom.remove.call(document,document.firstChild);
  const live=()=>session===current&&!current.controller.signal.aborted;
  const siblings=(children,parent,index=0)=>{
    for(;index<children.length&&live();index++){
      const operation=insert(children[index],parent);
      if(operation)return Promise.resolve(operation).then(()=>siblings(children,parent,index+1));
    }
  };
  const insert=(node,parent)=>{
    const script=node instanceof HTMLScriptElement||is_svg_script(node);
    const atomic=script||node instanceof HTMLStyleElement||globalThis.SVGStyleElement&&node instanceof SVGStyleElement||node instanceof HTMLTemplateElement;
    const copy=dom.clone.call(node,!!atomic);
    if(script){
      // Cloning an inert DOMParser script retains its non-executing state.
      // Parser scheduling, rather than insertion, executes the authored code.
      const attributes=[...copy.attributes].map(attribute=>[attribute.namespaceURI,attribute.name,attribute.value]);
      prime_inert_script(copy);for(const attribute of [...copy.attributes])copy.removeAttributeNode(attribute);
      for(const [namespace,name,value] of attributes)dom.attribute.call(copy,namespace,name,value);
      copy.__rewritten__=true;mark_parser_script(copy);
      // Native XML parser modules are already started without
      // executing. Preserve that state through later edits and cloning;
      // scripts created dynamically still use normal module preparation.
      const kind=is_svg_script(copy)?svg_script_kind(copy.getAttribute('type')):script_kind(copy.getAttribute('type'),copy.getAttribute('language'));
      if(kind==='module')copy.__sandstone_inert__=true;
    }
    prepare_resources(copy);
    const prepared=rewrite_element(copy);if(prepared)pending.push(Promise.resolve(prepared));
    dom.adopt.call(document,copy);activate_parser_event_attributes(copy);
    if(parent===document&&copy instanceof Element)current.root=copy;
    dom.append.call(parent,copy);
    reconcile_iframes(copy);
    if(script){
      if(!scriptingEnabled)return;
      return Promise.resolve(prepare_script(current,copy,null));
    }
    if(!atomic)return siblings([...node.childNodes],copy);
  };
  await siblings([...parsed.childNodes],document);
  if(!live())return;
  close(current);await current.finished;
}
function begin({source=false,scriptingEnabled=loader.site_settings.allow_js!==false}={}){
  const previous=session,targets=nodes(),saved=snapshot_runtime_events(targets);
  const previous_url=document.URL,sources=loader.document_sources();
  dom.open.call(document);loader.document_opened(previous_url,document.URL,sources);restore_runtime_events(saved);forget_document_listeners(targets);
  previous?.controller.abort(new DOMException('The document was replaced','AbortError'));
  const current={controller:new AbortController(),source,phase:'loading',async:[],deferred:[],finished:null};session=current;
  loader.set_ready_state('loading');
  current.stream=new HTMLDOMStream(document,{scriptingEnabled,signal:current.controller.signal,onMode:mode=>{
    // Let the native parser set the document's real layout mode. Its empty
    // shell is replaced by intercepted nodes before authored code can run.
    while(document.firstChild)dom.remove.call(document,document.firstChild);
    const header=mode==='quirks'?'':mode==='limited-quirks'?'<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">':'<!doctype html>';
    dom.write.call(document,header+'<html>');
    while(document.firstChild)dom.remove.call(document,document.firstChild);
  },onScript:(node,input)=>prepare_script(current,node,input)});
  return current;
}
function close(current){
  if(current.closing)return;current.closing=true;
  const parsed=current.stream.finish();
  const live=()=>session===current&&!current.controller.signal.aborted;
  const interactive=()=>{if(live()&&current.phase==='loading'){current.phase='interactive';loader.set_ready_state('interactive');emit(document,'readystatechange');}};
  const complete=()=>{
    if(!live())return;if(!current.xml)dom.close.call(document);current.phase='complete';loader.set_ready_state('complete');emit(document,'readystatechange');
    if(current.xml&&current.root===document.documentElement&&is_svg_root(current.root))emit(current.root,'load');
    if(!live())return;
    const loaded=new Event('load');Object.defineProperty(loaded,'target',{value:wrap_document(document)});globalThis.dispatchEvent(loaded);
    if(live())globalThis.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:false}));
    if(live())for(const callback of completion_observers)callback();
  };
  if(current.stream.closed)interactive();
  if(!live()){current.finished=Promise.resolve();return;}
  const imageLoads=current.stream.closed?images(current):[];
  if(live()&&current.stream.closed&&!current.stream.pendingResources&&!current.deferred.length&&!current.async.length&&!imageLoads.length&&!pending_script_loads()){
    emit(document,'DOMContentLoaded');
    const lateImages=images(current);
    if(!current.source&&!pending_script_loads()&&!lateImages.length){complete();current.finished=Promise.resolve();return;}
    // Source parsing yields for DOMContentLoaded microtasks before deciding
    // whether load is still delayed. Explicit document.close stays synchronous
    // when it has no pending resources, as in native written documents.
    current.finished=Promise.resolve().then(()=>wait_image_loads(current,lateImages)).then(()=>{if(live())complete();});return;
  }
  current.finished=parsed.then(async()=>{
    if(!live())return;interactive();
    if(!live())return;
    for(const execute of current.deferred){await execute();if(!live())return;}
    emit(document,'DOMContentLoaded');
    await Promise.allSettled([...current.async,current.stream.settled(),...styles(current),...imageLoads,...images(current)]);
    await wait_image_loads(current);if(!live())return;complete();
  }).catch(error=>{if(!current.controller.signal.aborted)console.error(error);});
}

if(globalThis.document){
  // The proxy dispatches lifecycle events for the virtual document. Hide only
  // the native parser's own document/window events, never resource load events.
  for(const name of ['readystatechange','DOMContentLoaded','load','pageshow'])listen_runtime(globalThis,name,event=>{
    if(session&&event.isTrusted&&(event.target===document||event.target===globalThis||session.xml&&event.target===session.root&&event.type==='load'))event.stopImmediatePropagation();
  },true);
  for(const method of ['open','write','writeln','close']){
    Document.prototype[method]=new Proxy(dom[method],{apply(target,receiver,args){
      receiver=unwrap_document(receiver);state.call(receiver);
      if(receiver!==document||type.call(receiver)!=='text/html'||method==='open'&&args.length>=3)return Reflect.apply(target,receiver,args);
      if(method==='open'){
        validation??=document.implementation.createHTMLDocument('');Reflect.apply(dom.open,validation,args);
        if(!writer)begin();return wrap_document(document);
      }
      if(method==='close'){if(writerOwner?.source)return;if(session)close(session);else Reflect.apply(target,receiver,args);return;}
      const text=strings(args)+(method==='writeln'?'\n':'');
      if(writer){writer.write(text);return;}
      if(ignoreWrites)return;
      if(!session||session.stream.closed)begin();
      session.stream.write(text);
    }});
  }
}
function is_svg_root(node){return node.namespaceURI==='http://www.w3.org/2000/svg'&&node.localName==='svg';}
