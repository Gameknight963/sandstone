import * as network from "./network.mjs";
import {encoding_parse_url} from '../url_encoding.mjs';
import * as polyfill from "./polyfill/index.mjs";
import * as intercept from "./intercept/index.mjs";
import * as parser from "./parser.mjs";
import * as loader from "./loader.mjs";
import { modules } from "./polyfill/module.mjs";
import { create_obj_proxy, global_method_names,scope_global,bind_native_property,bind_declared_property } from "./global_functions.mjs";
import {html_constructor_names,virtual_html_constructor,notify_dom_access} from './dom_operations.mjs';
import {parent_message_window,top_message_window,self_post_message} from './window_messages.mjs';
import {create_document_storage} from './storage_sync.mjs';
import {virtual_frame_window} from './iframe_window.mjs';
import * as rpc from '../rpc.mjs';
import {create_with_scope} from './with_scope.mjs';
import {create_global_bindings} from './global_bindings.mjs';
import {worker_module_intrinsics} from './module_namespace.mjs';
import {install_runtime_context} from './runtime_context.mjs';
import {create_direct_eval} from './direct_eval.mjs';
import {create_runtime_helpers} from './runtime_helpers.mjs';
import {install_node_documents} from './node_documents.mjs';
import {document_base_url} from './document_base.mjs';
import {create_response_redirect} from './response.mjs';
export {get_runtime_context} from './runtime_context.mjs';
export {get_global_reflection_group} from './global_reflection.mjs';
export {is_default_open,default_open} from './intercept/open.mjs';
const parse_json = JSON.parse;
const realm_global=globalThis,evaluate_global=globalThis.eval,describe_global=Reflect.getOwnPropertyDescriptor,define_global=Reflect.defineProperty;
let with_entry;
const native_worker_post=realm_global.postMessage?.bind(realm_global);

export const is_worker = typeof importScripts === "function";
export const ctx_vars = [];
export const unreadable_vars = ["localStorage", "sessionStorage", "importScripts"];
if (is_worker) 
  unreadable_vars.push("document");

const internal = {
  location: null,
  self: null,
  globalThis: null,
  eval: null,
  history: null,
  localStorage: null,
  sessionStorage: null
};

export function get_handler_keys(obj) {
  let keys = [];
  let own_keys = Reflect.ownKeys(Object.getPrototypeOf(obj));
  for (let key of own_keys) {
    if (key === "constructor") continue;
    if (key.startsWith("__")) continue;
    keys.push(key);
  }
  return keys;
}

export class CustomCTX {
  get __module_intrinsics__(){return worker_module_intrinsics;}
  constructor() {
    ctx_vars.push(...new Set([...get_handler_keys(this),...global_method_names(globalThis),...html_constructor_names]));
    this.__proxy__ = create_obj_proxy(this, ctx_vars, globalThis, (value,key)=>virtual_html_constructor(virtual_frame_window(value,key)),undefined,undefined,{virtual_accessors:true});
  }

  set location(value) {internal.location.assign(value)}
  get location() {return internal.location}

  set self(value) {internal.self = value}
  get self() {return internal.self}
  set globalThis(value) {internal.globalThis = value}
  get globalThis() {return internal.globalThis}

  get window() {return is_worker ? undefined : this.__proxy__}
  get frames() {return is_worker ? undefined : this.__proxy__}
  get name() {return globalThis.name}
  set name(value) {
    globalThis.name=value;
    if(!is_worker&&loader.is_iframe)rpc.call_procedure(rpc.host,'window_name',[loader.frame_id,loader.beacon_context,globalThis.name]).catch(console.error);
  }
  get origin() {return loader.document_origin ?? this.location.origin}
  get document() {return is_worker ? undefined : intercept.document.__proxy__}
  get parent() {
    if (is_worker) return undefined;
    if (loader.is_iframe)
      return parent_message_window();
    return this.__proxy__;
  }
  get top() {
    if (is_worker) return undefined;
    if (loader.is_iframe)
      return top_message_window();
    return this.__proxy__;
  }

  fetch() {return polyfill.fetch(...arguments)}
  get postMessage(){return loader.service_worker?undefined:is_worker?native_worker_post:self_post_message;}
  get Request() {return polyfill.FakeRequest}
  get ServiceWorker(){return polyfill.service_workers.service_worker_api()?.ServiceWorker;}
  get ServiceWorkerRegistration(){return polyfill.service_workers.service_worker_api()?.ServiceWorkerRegistration;}
  get ServiceWorkerContainer(){return polyfill.service_workers.service_worker_api()?.ServiceWorkerContainer;}
  get Function(){return Object.hasOwn(internal,'Function')?internal.Function:polyfill.Function;}
  set Function(value){internal.Function=value;}
  get URL() {return polyfill.FakeURL}
  get Worker() {return loader.service_worker?undefined:polyfill.FakeWorker}
  get importScripts() {return is_worker ? polyfill.fakeImportScripts : undefined}
  __load_worker_scripts__(paths,loaded,failed,importScripts){return polyfill.load_worker_scripts(paths,loaded,failed,importScripts);}
  get XMLHttpRequest() {return polyfill.FakeXMLHttpRequest}
  get EventSource() {return polyfill.FakeEventSource}
  get XMLHttpRequestUpload() {return polyfill.FakeXMLHttpRequest.Upload}
  get XMLHttpRequestEventTarget() {return polyfill.FakeXMLHttpRequest.EventTarget}
  get CSSStyleSheet() {return intercept.FakeCSSStyleSheet}
  get history() {return internal.history}

  get localStorage() {if(internal.storage_unavailable)throw new DOMException('Storage origin is unavailable','SecurityError');return internal.localStorage}
  get sessionStorage() {if(internal.storage_unavailable)throw new DOMException('Storage origin is unavailable','SecurityError');return internal.sessionStorage}
  get WebSocket() {return network.WebSocket}
  get BroadcastChannel(){return polyfill.BroadcastChannel;}
  get Lock(){return polyfill.locks.Lock;}
  get LockManager(){return polyfill.locks.LockManager;}
  get MutationObserver(){return Object.hasOwn(internal,'MutationObserver')?internal.MutationObserver:intercept.mutation_observer.MutationObserver;}
  set MutationObserver(value){internal.MutationObserver=value;}
  get IntersectionObserver(){return Object.hasOwn(internal,'IntersectionObserver')?internal.IntersectionObserver:intercept.intersection_observer.IntersectionObserver;}
  set IntersectionObserver(value){internal.IntersectionObserver=value;}
  get Range(){return Object.hasOwn(internal,'Range')?internal.Range:intercept.ranges.Range;}
  set Range(value){internal.Range=value;}
  get StaticRange(){return Object.hasOwn(internal,'StaticRange')?internal.StaticRange:intercept.ranges.StaticRange;}
  set StaticRange(value){internal.StaticRange=value;}
  get indexedDB() {return polyfill.idb.indexedDB}
  get caches(){if(is_worker&&this.origin==='null')return undefined;if(internal.storage_unavailable||this.origin==='null')throw new DOMException('Cache origin is unavailable','SecurityError');return polyfill.cache.caches}
  get Cache(){return is_worker&&this.origin==='null'?undefined:polyfill.cache.Cache}
  get CacheStorage(){return is_worker&&this.origin==='null'?undefined:polyfill.cache.CacheStorage}
  get IDBFactory() {return polyfill.idb.IDBFactory}
  get IDBDatabase() {return polyfill.idb.IDBDatabase}
  get IDBTransaction() {return polyfill.idb.IDBTransaction}
  get IDBObjectStore() {return polyfill.idb.IDBObjectStore}
  get IDBIndex() {return polyfill.idb.IDBIndex}
  get IDBRequest() {return polyfill.idb.IDBRequest}
  get IDBOpenDBRequest() {return polyfill.idb.IDBOpenDBRequest}
  get IDBCursor() {return polyfill.idb.IDBCursor}
  get IDBCursorWithValue() {return polyfill.idb.IDBCursorWithValue}
  get IDBKeyRange() {return polyfill.idb.IDBKeyRange}
  get IDBVersionChangeEvent() {return polyfill.idb.IDBVersionChangeEvent}

  eval(js) {
    return typeof js==='string'?run_script(js):js;
  }
  __eval_scope__(){return direct_eval.scope();}
  __eval_declare__(scope,names){direct_eval.declare(scope,names);}
  __eval_reference__(...args){return direct_eval.reference(...args);}
  __eval_select__(reference,physical){return direct_eval.select(reference,physical);}
  __eval_function__(value){return direct_eval.name(value);}
  __eval_physical__(){return direct_eval.physical();}
  __eval_binding__(...args){return direct_eval.binding(...args);}
  __eval_custom__(){return direct_eval.custom();}
  __eval_prepare__(args,context){return direct_eval.prepare(args,context);}

  __import__(referrer, specifier, options) {
    const base=referrer===null?()=>is_worker?ctx.location.href:ctx.document.baseURI:referrer;
    return modules.import(specifier,base,options);
  }
  __module_meta__(url) { return modules.meta(url); }
  __json_module__(source) { return parse_json(source); }
  __css_module__(source,url){return intercept.create_css_module(source,url);}
  __worker_module_started__() { polyfill.mark_worker_started(); }
  get __globals__(){return global_bindings.globals;}
  __declare_global_lexicals__(definitions){global_bindings.declare(definitions);}
  __publish_legacy_function__(name,value){if(!global_bindings.has(name))Reflect.set(ctx.__proxy__,name,value,ctx.__proxy__);return value;}
  __enter_with__(value,parent,evalFallback,physicalEval){const token=create_with_scope(value,parent,runtime_helpers,global_bindings.globals,evalFallback,physicalEval);with_entry={token,previous:with_entry};return token.object;}
  __take_with__(){const entry=with_entry;with_entry=entry?.previous;return entry?.token;}
  __declare_global_vars__(names){for(const name of names)bind_declared_property(ctx.__proxy__,name);}

  __publish_global_function__(name,value){
    const descriptor=describe_global(realm_global,name);
    if(!descriptor||!define_global(ctx.__proxy__,name,{...descriptor,value}))throw new TypeError('Cannot define global function '+name);
    bind_native_property(ctx.__proxy__,name);
    return value;
  }

  __get_this__(this_obj,strict=false) {
    const scoped=scope_global(this_obj);if(scoped)return strict?undefined:scoped;
    if (this_obj === globalThis)
      return ctx.__proxy__;
    notify_dom_access(this_obj);
    return this_obj;
  }

  __get_var__(var_value, var_name) {
    let global_obj = globalThis[var_name];
    if (var_value === global_obj) 
      return ctx.__proxy__[var_name];
    else 
      return var_value;
  }
}

export const ctx = new CustomCTX();
const response_redirect=Object.getOwnPropertyDescriptor(realm_global.Response,'redirect');
Object.defineProperty(realm_global.Response,'redirect',{...response_redirect,value:create_response_redirect(()=>is_worker?ctx.location.href:document_base_url()||ctx.location.href)});
const global_bindings=create_global_bindings(ctx.__proxy__);
const direct_eval=create_direct_eval({native:evaluate_global,virtual:CustomCTX.prototype.eval,global:realm_global,
  rewrite:(source,context)=>parser.rewrite_js(source,{url:context.url||loader.url,importReferrer:context.importReferrer,evalMode:true,evalContext:context})});
export const runtime_helpers=create_runtime_helpers(ctx,Reflect.ownKeys(CustomCTX.prototype).filter(name=>typeof name==='string'&&name.startsWith('__')));

export function proxy_function(target, key, apply_callback) {
  if (!target) return;
  target[key] = new Proxy(target[key], {apply: apply_callback});
}

export function wrap_function(key, wrapper, target) {
  wrapper[key] = new Proxy(target[key], {
    apply: function(func_target, this_arg, arguments_list) {
      return Reflect.apply(func_target, target, arguments_list);
    }
  });
}

export function wrap_obj(wrapper, target) {
  wrapper.__target__ = target;
  let wrapper_proto = Object.getPrototypeOf(wrapper);
  let target_keys = Reflect.ownKeys(target);
  let target_proto = Object.getPrototypeOf(target);
  while (target_proto != null) {
    target_keys.push(...Reflect.ownKeys(target_proto));
    target_proto = Object.getPrototypeOf(target_proto);
  }

  let exclude = ["eval"];
  for (let key of target_keys) {
    if (wrapper_proto.hasOwnProperty(key)) continue;
    if (key === "__proto__") continue;
    if (exclude.includes(key)) continue;
    try {
      if (typeof target[key] === "function") {
        wrap_function(key, wrapper, target);
        continue;
      }
      try {
        wrapper[key] = target[key];
      }
      catch {
        Object.defineProperty(wrapper, key, {
          configurable: true,
          value: target[key],
          writable: true
        })
      }
    }
    catch (e) {
      if (e instanceof DOMException) continue;
      if (e instanceof TypeError) continue;
    }
  }
}

export function update_ctx(options = {}) {
  let storageReady;
  if(!options.reuse_window){
    internal.location = is_worker ? new polyfill.FakeWorkerLocation() : new polyfill.FakeLocation(options);
    internal.self = ctx.__proxy__;
    internal.globalThis = ctx.__proxy__;
  }
  if (is_worker) { internal.localStorage = undefined; internal.sessionStorage = undefined; }
  if (!is_worker) {
    internal.storage_unavailable=ctx.origin==='null';
    const stores=create_document_storage(options,()=>ctx.location.href,()=>ctx.window);
    internal.localStorage=stores.local;internal.sessionStorage=stores.session;
    storageReady=stores.ready.then(snapshot=>{internal.storage_unavailable=!!snapshot.opaque;});
  }
  // Register the History view after storage selects the same-origin document
  // registry, so borrowed methods can recognize accessible peer histories.
  if(options.reuse_window)polyfill.retarget_history(internal.history);
  else internal.history = is_worker ? undefined : new polyfill.FakeHistory(options.history);
  if(!is_worker)install_node_documents(intercept.document);
  // Native Navigation targets the physical sandbox document. Hide its feature
  // flags until it can use virtual history, so routers use their History fallback.
  // Native network APIs without relay adapters must not connect directly.
  // WebSocketStream needs backpressure and close metadata the current socket
  // transport cannot supply; SharedWorker cannot run in this opaque origin.
  // Remove configurable properties so `in` checks also select site fallbacks.
  for (const key of ["navigation", "NavigationPrecommitController", "RTCPeerConnection", "webkitRTCPeerConnection", "WebSocketStream", "WebTransport", "SharedWorker"]) {
    try { if(!Reflect.deleteProperty(globalThis,key))Object.defineProperty(globalThis,key,{value:undefined,configurable:true}); } catch {}
  }

  install_runtime_context(ctx.__proxy__,runtime_helpers);
  return storageReady;
}

export function convert_url(url, base, encoding) {
  let url_obj = encoding_parse_url(url, base, encoding);
  return url_obj.href;
}

export function run_script_safe(js) {
  try {
    run_script(js);
  }
  catch (e) {
    console.error(e);
  }
}

export function run_script(js, options={}) {
  //indirect eval preserves global variables
  let rewritten_js = parser.rewrite_js(js, {url: loader.url,...options,evalMode:true});
  return evaluate_global?.(rewritten_js);
}

export function intercept_property(target, key, handler) {
  let prototype = Object.getPrototypeOf(target);
  let descriptor;
  while (prototype && !descriptor) {
    descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    prototype = Object.getPrototypeOf(prototype);
  }
  if (!descriptor) return;
  Object.defineProperty(target, key, {configurable: true, enumerable: descriptor.enumerable, ...handler});
  return descriptor;
}

// HTMLFormElement named controls override instance properties, including DOM
// accessors such as children and attributes. Internal traversal must bypass them.
export function get_dom_property(target, key) {
  let prototype = target && Object.getPrototypeOf(target);
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (descriptor) return descriptor.get ? descriptor.get.call(target) : descriptor.value;
    prototype = Object.getPrototypeOf(prototype);
  }
}
