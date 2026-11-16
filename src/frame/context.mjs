import * as network from "./network.mjs";
import * as polyfill from "./polyfill/index.mjs";
import * as intercept from "./intercept/index.mjs";
import * as parser from "./parser.mjs";
import * as loader from "./loader.mjs";
import { modules } from "./polyfill/module.mjs";
import { bind_global_function } from "./global_functions.mjs";
const parse_json = JSON.parse;

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

export function create_obj_proxy(obj, ctx_vars, target) {
  let proxies = new Map();

  const proxy = new Proxy(target, {
    get: (_, key) => {
      if (typeof obj[key] !== "undefined")
        return obj[key];
      if (typeof target[key] === "function" && !target[key].prototype) {
        if (!proxies.has(key)) 
          proxies.set(key, bind_global_function(target, target[key], proxy))
        return proxies.get(key)
      }
      return target[key];
    },
    set: (_, key, value) => {
      if (ctx_vars.includes(key))
        obj[key] = value;
      else
        target[key] = value;
      return true;
    }
  });
  return proxy;
}

export class CustomCTX {
  constructor() {
    ctx_vars.push(...get_handler_keys(this));
    this.__proxy__ = create_obj_proxy(this, ctx_vars, globalThis);
  }

  set location(value) {internal.location.assign(value)}
  get location() {return internal.location}

  set self(value) {internal.self = value}
  get self() {return internal.self}
  set globalThis(value) {internal.globalThis = value}
  get globalThis() {return internal.globalThis}

  get window() {return is_worker ? undefined : this.__proxy__}
  get origin() {return this.location.origin}
  get document() {return is_worker ? undefined : intercept.document.__proxy__}
  get parent() {
    if (is_worker) return undefined;
    if (loader.is_iframe)
      return globalThis.parent;
    return this.__proxy__;
  }
  get top() {
    if (is_worker) return undefined;
    if (loader.is_iframe)
      return globalThis.parent;
    return this.__proxy__;
  }

  fetch() {return polyfill.fetch(...arguments)}
  get URL() {return polyfill.FakeURL}
  get Worker() {return polyfill.FakeWorker}
  get importScripts() {return is_worker ? polyfill.fakeImportScripts : undefined}
  get XMLHttpRequest() {return polyfill.FakeXMLHttpRequest}
  get XMLHttpRequestUpload() {return polyfill.FakeXMLHttpRequest.Upload}
  get XMLHttpRequestEventTarget() {return polyfill.FakeXMLHttpRequest.EventTarget}
  get history() {return internal.history}

  get localStorage() {return internal.localStorage}
  get sessionStorage() {return internal.sessionStorage}
  get WebSocket() {return network.WebSocket}
  get indexedDB() {return polyfill.idb.indexedDB}
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
    return run_script(String(js));
  }

  __import__(referrer, specifier, options) { return modules.import(specifier, referrer, options); }
  __module_meta__(url) { return modules.meta(url); }
  __json_module__(source) { return parse_json(source); }
  __worker_module_started__() { polyfill.mark_worker_started(); }

  __get_this__(this_obj) {
    if (this_obj === globalThis)
      return ctx.__proxy__;
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
  internal.location = is_worker ? new polyfill.FakeWorkerLocation() : new polyfill.FakeLocation();
  internal.self = ctx.__proxy__;
  internal.globalThis = ctx.__proxy__;
  internal.history = is_worker ? undefined : new polyfill.FakeHistory(options.history);
  if (is_worker) { internal.localStorage = undefined; internal.sessionStorage = undefined; }
  if (!is_worker) {
  internal.localStorage = new polyfill.FakeStorage(options.local_storage, entries => {
    loader.local_storage(loader.frame_id, entries).catch(console.error);
  });
  internal.sessionStorage = new polyfill.FakeStorage(options.session_storage, entries => {
    loader.session_storage(loader.frame_id, entries).catch(console.error);
  });
  }
  delete globalThis.caches;
  // These APIs would bypass the relay and contact destination peers directly.
  for (const key of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
    try { Object.defineProperty(globalThis, key, {value: undefined, configurable: true}); } catch {}
  }

  globalThis.__ctx__ = ctx.__proxy__;
  globalThis.__get_this__ = ctx.__get_this__;
  globalThis.__get_var__ = ctx.__get_var__;
}

export function convert_url(url, base) {
  let url_obj = new URL(url, base);
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

export function run_script(js) {
  //indirect eval preserves global variables
  let rewritten_js = parser.rewrite_js(js, {url: loader.url});
  return eval?.(rewritten_js);
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
