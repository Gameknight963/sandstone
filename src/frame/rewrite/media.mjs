import { ctx, intercept_property, proxy_function } from "../context.mjs";
import * as network from "../network.mjs";
import { rewrite_srcset } from "../srcset.mjs";

const prepared = new WeakMap();
const sessions = new WeakMap();
const source_loads = new WeakMap();
const owner=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'ownerDocument').get;
const native_base=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'baseURI').get;
const view=globalThis.Document&&Object.getOwnPropertyDescriptor(Document.prototype,'defaultView').get;
const set=globalThis.Element?.prototype.setAttribute,remove_attribute=globalThis.Element?.prototype.removeAttribute;
const attr_owner=globalThis.Attr&&Object.getOwnPropertyDescriptor(Attr.prototype,'ownerElement').get;
const attr_value=globalThis.Attr&&Object.getOwnPropertyDescriptor(Attr.prototype,'value');
const dispatch=globalThis.EventTarget?.prototype.dispatchEvent;
const attribute=globalThis.Element?.prototype.getAttribute;
let policy_observer;
const image_prototype=globalThis.HTMLImageElement?.prototype;
const image_properties=image_prototype&&Object.fromEntries(['src','srcset','currentSrc'].map(key=>[key,Object.getOwnPropertyDescriptor(image_prototype,key)]));
const well_formed=String.prototype.toWellFormed;

function reflected_source(element,key,native){
  const session=sessions.get(element),value=session?.authored.get(key);
  if(value===null||value===undefined)return native;
  if(key==='srcset')return value;
  try{return new URL(value,session.base()).href;}catch{return value;}
}
if(image_properties)for(const [key,property] of Object.entries(image_properties)){
  const descriptor={...property,get:new Proxy(property.get,{apply(target,receiver,args){
    const native=Reflect.apply(target,receiver,args);
    if(key==='currentSrc')return network.known_urls[native]||sessions.get(receiver)?.aliases.get(native)||native;
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
  const target=request_element(element);
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
function refresh_source(element){
  const session=sessions.get(element);if(!session)return;
  for(const [key,value] of session.authored){
    const state=session.states.get(key),target=request_element(element,key);
    if(value!==null&&(state.waiting?!!target:state.requestElement!==target))state.update(value,session.active);
  }
}
function observe_policy(element,options){
  policy_observer??=new MutationObserver(records=>{
    const sources=new Set();
    for(const record of records){
      if(record.type==='attributes')refresh_image_policy(record.target);
      else{
        for(const node of [...record.target.children,...record.removedNodes])if(node instanceof HTMLSourceElement)sources.add(node);
      }
    }
    for(const source of sources)refresh_source(source);
  });
  policy_observer.observe(element,options);
}
export function observe_media_container(element){
  if(element instanceof HTMLPictureElement||element instanceof HTMLMediaElement)observe_policy(element,{childList:true});
}

function source_pending(element) {
  const parent = element.parentElement;
  if (!(element instanceof HTMLSourceElement) || !(parent instanceof HTMLMediaElement)) return () => {};
  const state = source_loads.get(parent) || {pending: 0, revision: 0};
  source_loads.set(parent, state);
  state.pending++;
  state.revision++;
  return () => {
    state.pending--;
    const revision = ++state.revision;
    queueMicrotask(() => {
      if (!state.pending && state.revision === revision && parent.isConnected) parent.load();
    });
  };
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
  const current=prepared.get(source);if(!current)return;
  const authored=new Map(current);
  return (copy,inactive=false)=>{
    if(inactive){for(const [key,value] of authored)if(value===null)remove_attribute.call(copy,key);else set.call(copy,key,value);}
    else rewrite_media(copy,authored);
    return true;
  };
}

export function detach_media_attribute(node){
  const element=attr_owner.call(node),session=sessions.get(element),key=node.localName;
  if(node.namespaceURI!==null||!session?.authored.has(key))return false;
  const value=session.authored.get(key),state=session.states.get(key);
  session.authored.set(key,null);state.generation++;state.controller?.abort();state.release(state.urls);state.urls=[];
  remove_attribute.call(element,key);attr_value.set.call(node,value);return true;
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
  const remove = element.removeAttribute.bind(element);
  const properties = element instanceof HTMLImageElement?['src','srcset']:["src", "srcset", "poster"].filter(key => key in element);
  const authored = new Map(initial_sources||properties.map(key => [key, get(key)]));
  prepared.set(element,authored);
  const states = new Map();
  const base = () => owner.call(element)===document?ctx.document.baseURI:native_base.call(element);
  const aliases=new Map(),session={authored,states,active:true,crossOrigin:cross_origin(element),aliases,base};sessions.set(element,session);
  if(element instanceof HTMLImageElement){
    observe_policy(element,{attributes:true,attributeFilter:['crossorigin']});
  }
  observe_media_container(element);
  if(element instanceof HTMLSourceElement)observe_media_container(element.parentElement);
  // Clear every source before starting asynchronous work, including picture sources.
  for (const key of properties) remove(key);

  for (const key of properties) {
    const state = {generation: 0, urls: [], controller: null,waiting:false,requestElement:null};
    states.set(key, state);
    const release = urls => {
      for (const url of urls) { URL.revokeObjectURL(url); delete network.known_urls[url]; }
    };
    let descriptor;
    function update(value,intended_active) {
      value = String(value);
      authored.set(key, value);
      const document=owner.call(element),active=intended_active??!!view.call(document);
      const request_base=active?ctx.document.baseURI:base();
      session.active=active;
      const generation = ++state.generation;
      state.controller?.abort();
      const controller = state.controller = new AbortController();
      remove(key);
      release(state.urls);
      state.urls = [];
      const urls = [];
      const resources = new Map();
      let request_options;
      const done=key==='src'?source_pending(element):()=>{};
      const source=element instanceof HTMLSourceElement;
      state.requestElement=request_element(element,key);
      state.waiting=active&&source&&!state.requestElement;
      // A source has no independent loader. Keep its authored URL virtual until
      // a picture image or media parent can supply the actual request context.
      if(state.waiting)return;
      const resource = async source => {
        if (!source) return source;
        const url = new URL(source, request_base);
        if (["data:", "blob:"].includes(url.protocol)) return url.href;
        if (!resources.has(url.href)) resources.set(url.href, (async () => {
          const response = await network.fetch(url.href, request_options);
          if (!response.ok) throw new TypeError(`Media request failed: ${response.status}`);
          const blob = await response.blob();
          controller.signal.throwIfAborted();
          const local = network.create_blob_url(blob, url.href);
          aliases.set(local,url.href);
          urls.push(local);
          return local;
        })());
        return resources.get(url.href);
      };
      // Local sources retain their synchronous property behavior.
      if (!active || key !== "srcset" && (!value || /^(data|blob):/i.test(value))) {
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
            mode:crossOrigin===null?'no-cors':'cors',referrerPolicy:state.requestElement.referrerPolicy};
          const rewritten = key === "srcset" ? await rewrite_srcset(value, async source => {
            try { return await resource(source); }
            catch (error) { if (controller.signal.aborted) throw error; return "data:application/octet-stream,"; }
          }) : await resource(value);
          if (generation !== state.generation) { release(urls); return; }
          state.urls = urls;
          descriptor.set.call(element, rewritten);
        } catch (error) {
          release(urls);
          if (generation === state.generation && !controller.signal.aborted) dispatch.call(element,new Event("error"));
        } finally { done(); }
      })();
    }
    descriptor = element instanceof HTMLImageElement?image_properties[key]:intercept_property(element, key, {
      get() {
        const value = authored.get(key);
        if (value === null || value === undefined) return descriptor.get.call(element);
        if (key === "srcset") return value;
        try { return new URL(value, base()).href; } catch { return value; }
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
        return network.known_urls[value] || aliases.get(value) || value;
      }
    });
  }
  proxy_function(element, "getAttribute", (target, receiver, args) => {
    const key = String(args[0]).toLowerCase();
    return authored.has(key) ? authored.get(key) : Reflect.apply(target, receiver, args);
  });
  proxy_function(element, "hasAttribute", (target, receiver, args) => {
    const key = String(args[0]).toLowerCase();
    return authored.has(key) ? authored.get(key) !== null : Reflect.apply(target, receiver, args);
  });
  proxy_function(element, "setAttribute", (target, receiver, args) => {
    const state = states.get(String(args[0]).toLowerCase());
    if (state) { state.update(args[1]); return; }
    return Reflect.apply(target, receiver, args);
  });
  proxy_function(element, "removeAttribute", (target, receiver, args) => {
    const key = String(args[0]).toLowerCase();
    const state = states.get(key);
    if (state) {
      authored.set(key, null);
      state.generation++;
      state.controller?.abort();
      state.release(state.urls);
      state.urls = [];
    }
    return Reflect.apply(target, receiver, args);
  });
  proxy_function(element, "toggleAttribute", (target, receiver, args) => {
    const key = String(args[0]).toLowerCase();
    if (!states.has(key)) return Reflect.apply(target, receiver, args);
    const exists = element.hasAttribute(key);
    const wanted = args.length > 1 ? Boolean(args[1]) : !exists;
    if (wanted && !exists) element.setAttribute(key, "");
    if (!wanted && exists) element.removeAttribute(key);
    return wanted;
  });
  for (const method of ["setAttributeNS", "getAttributeNS", "hasAttributeNS", "removeAttributeNS"]) {
    proxy_function(element, method, (target, receiver, args) => {
      if (args[0] === null || args[0] === "") {
        return element[method.replace("NS", "")](...args.slice(1));
      }
      return Reflect.apply(target, receiver, args);
    });
  }
  // Removing a temporary source can produce a native empty-source error.
  element.addEventListener("error", event => {
    if (!event.isTrusted) return;
    if (properties.every(key => !get(key))) event.stopImmediatePropagation();
  }, true);
  for (const [key, value] of authored) if (value !== null) states.get(key).update(value,true);
}
