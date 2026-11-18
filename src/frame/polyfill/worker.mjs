import * as network from "../network.mjs";
import * as loader from "../loader.mjs";
import * as rpc from "../../rpc.mjs";
import {bootstrap_worker,create_bootstrap_nonce} from '../../bootstrap.mjs';
import * as parser from "../parser.mjs";
import { ctx, update_ctx, convert_url } from "../context.mjs";
import { modules } from "./module.mjs";
import { prefetch_worker_scripts } from "../worker_scripts.mjs";
import {on_document_unload} from '../runtime_events.mjs';

const NativeWorker = globalThis.Worker;
const native_import_scripts = globalThis.importScripts?.bind(globalThis);
const native_post = globalThis.postMessage?.bind(globalThis);
const NativeXHR = globalThis.XMLHttpRequest;
const NativeMessageEvent=globalThis.MessageEvent,NativeErrorEvent=globalThis.ErrorEvent;
const native_timeout=globalThis.setTimeout.bind(globalThis),native_clear_timeout=globalThis.clearTimeout.bind(globalThis);
const native_dispatch=globalThis.dispatchEvent?.bind(globalThis);
const imported_blobs = new Map();
function replace_worker_method(name,value){
  let owner=globalThis;
  while(owner&&!Object.hasOwn(owner,name))owner=Object.getPrototypeOf(owner);
  const descriptor=owner&&Object.getOwnPropertyDescriptor(owner,name);
  // Preserve inherited API placement: a later classic var declaration must
  // still be able to create its own undefined binding over this method.
  if(descriptor&&'value'in descriptor)Object.defineProperty(owner,name,{...descriptor,value});
  else globalThis[name]=value;
}
let worker_options;
let worker_ready = false;
let message_queue = [];
let pumping = false;

function pump() {
  if (!worker_ready || pumping || !message_queue.length) return;
  pumping = true;
  native_timeout(() => {
    pumping = false;
    const event = message_queue.shift();
    if (event) native_dispatch(new NativeMessageEvent(event.type, {data: event.data, ports: [...event.ports]}));
    pump();
  }, 0);
}

export function mark_worker_started() {
  if (worker_ready) return;
  native_timeout(() => { worker_ready = true; pump(); }, 0);
}

export function fakeImportScripts(...paths) {
  if (loader.worker_type === "module") throw new TypeError("Module scripts don't support importScripts()");
  const urls = paths.map(path => convert_url(String(path), loader.url));
  const blobs = urls.map(url => {
    let source = network.resource_cache[url];
    if (source === undefined && /^(data|blob):/.test(url) && NativeXHR) {
      const request = new NativeXHR();
      request.open("GET", url, false);
      request.send();
      source = request.responseText;
      network.cache_put(url, source);
    }
    if (source === undefined && worker_options?.probe) {
      native_post({sandstone_worker: worker_options.token, type: "need-script", url});
      throw new DOMException("Worker discovery needs a script", "NetworkError");
    }
    if (typeof source !== "string") throw new DOMException(`Worker script is unavailable: ${url}`, "NetworkError");
    if (!imported_blobs.has(url)) {
      const scriptURL=worker_options?.source_urls?.[url]||url;
      const rewritten = parser.rewrite_js(source, {url:scriptURL,sourceURL:scriptURL});
      imported_blobs.set(url, network.create_blob_url(new Blob([rewritten], {type: "text/javascript"}), scriptURL));
    }
    return imported_blobs.get(url);
  });
  native_import_scripts(...blobs);
}

// Invoked by the native worker bootstrap, in its own thread and opaque origin.
export function initialize_worker(options) {
  options.source??=options.sources?.[options.url];
  worker_options = options;
  loader.set_worker_context(options);
  update_ctx();
  replace_worker_method('importScripts',fakeImportScripts);
  for (const [url, source] of Object.entries(options.sources || {})) network.cache_put(url, source);
  if(typeof options.source==='string')network.cache_put(options.url,options.source);
  if (options.probe) {
    network.enable_network(false);
    const blocked = () => { throw new DOMException("Network disabled during worker discovery", "NetworkError"); };
    for (const key of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport"]) {
      try { globalThis[key] = blocked; } catch {}
    }
    globalThis.postMessage = () => {};
    for (const key of ["log", "warn", "error", "info"]) console[key] = () => {};
    try { fakeImportScripts(options.url); } catch {}
    native_timeout(() => native_post({sandstone_worker: options.token, type: "probe-done"}), 500);
    return;
  }

  let port;
  let host_ready = false;
  let started = false;
  const start = async () => {
    if (started || !port || !host_ready) return;
    started = true;
    network.enable_network();
    try {
      if (options.type === "module") {
        modules.preamble = "__ctx__.__worker_module_started__();\n";
        const record = modules.record(options.url, "javascript", options.credentials);
        record.source = options.source;
        await modules.import(options.url, options.url);
      } else {
        // Native classic-script evaluation preserves strict globals and lexical
        // bindings across imported files; indirect eval gives them another scope.
        fakeImportScripts(options.url);
      }
      mark_worker_started();
    } catch (error) {
      native_post({sandstone_worker: options.token, type: "error", message: error.message, name: error.name, stack: error.stack});
    }
  };
  rpc.set_on_attach(() => { host_ready = true; start(); });
  const connect = event => {
    if (event.data?.sandstone_worker !== options.token || event.data.type !== "connect" || !event.ports[0]) return;
    event.stopImmediatePropagation();
    globalThis.removeEventListener("message", connect);
    port = event.ports[0];
    port.onmessage = event => { message_queue.push(event); pump(); };
    port.onmessageerror = event => { message_queue.push(event); pump(); };
    port.start();
    start();
  };
  globalThis.addEventListener("message", connect);
  const native_close = globalThis.close.bind(globalThis);
  replace_worker_method('close',() => {
    native_post({sandstone_worker: options.token, type: "closed"});
    native_close();
  });
}

function handler(target, type) {
  let callback;
  Object.defineProperty(target, "on" + type, {
    enumerable: true, configurable: true,
    get: () => callback?.original || null,
    set(value) {
      if (callback) target.removeEventListener(type, callback);
      callback = typeof value === "function" ? event => { if (value.call(target, event) === false) event.preventDefault(); } : null;
      if (callback) { callback.original = value; target.addEventListener(type, callback); }
    }
  });
}

export class FakeWorker extends EventTarget {
  #url; #options; #worker; #port; #receiver; #terminated = false;
  #id = "" + Math.random();
  #token = "" + Math.random();
  #registered = false;
  #bootstrap;
  #bootstrap_nonce=create_bootstrap_nonce();
  #controller = new AbortController();
  #removeUnload;
  #source_urls=new Map();

  constructor(url, options = {}) {
    super();
    this.#url = convert_url(String(url), ctx.document?.baseURI || ctx.location.href);
    this.#options = {...options, type: options.type || "classic", credentials: options.credentials || "same-origin"};
    if (!["classic", "module"].includes(this.#options.type)) throw new TypeError("Invalid worker type");
    if (!["omit", "same-origin", "include"].includes(this.#options.credentials)) throw new TypeError("Invalid worker credentials");
    const target = new URL(this.#url);
    if (/^https?:$/.test(target.protocol) && target.origin !== ctx.origin) throw new DOMException("Worker must be same-origin", "SecurityError");
    const channel = new MessageChannel();
    this.#port = channel.port1;
    this.#receiver = channel.port2;
    for (const type of ["message", "messageerror", "error"]) handler(this, type);
    this.#removeUnload = on_document_unload(() => this.terminate());
    this.#start().catch(error => { if (!this.#terminated) { this.#error(error); this.terminate(); } });
  }

  #error(error) {
    const event = new NativeErrorEvent("error", {message: error.message, filename: this.#url, error, cancelable: true});
    if (this.dispatchEvent(event)) console.error(error);
  }

  #payload(source, url, sources, probe = false) {
    return {
      source:sources.get(url)===source?undefined:source, url, sources: Object.fromEntries(sources), source_urls:Object.fromEntries(this.#source_urls),probe,
      frame_id: this.#id, token: this.#token, type: this.#options.type,
      credentials: this.#options.credentials, runtime_src: loader.runtime_src,
      crypto_available: loader.crypto_available,
      referrer_policy: loader.referrer_policy,
      origin: new URL(url).protocol === "data:" ? "null" : ctx.origin
    };
  }

  #blob(payload) {
    return URL.createObjectURL(new Blob([
      bootstrap_worker(loader.runtime_src,this.#bootstrap_nonce), "\nsandstone_frame.worker.initialize_worker(", JSON.stringify(payload), ");"
    ], {type: "text/javascript"}));
  }

  async #probe(source, url, sources) {
    for (let attempt = 0; attempt < 32 && !this.#terminated; attempt++) {
      const payload = this.#payload(source, url, sources, true);
      payload.type = "classic";
      const blob = this.#blob(payload);
      const probe = new NativeWorker(blob);
      let timer;
      let abort;
      const missing = await new Promise(resolve => {
        abort = () => resolve(null);
        this.#controller.signal.addEventListener("abort", abort, {once: true});
        timer = native_timeout(() => resolve(null), 1500);
        probe.onmessage = event => {
          if (event.data?.sandstone_worker !== this.#token) return;
          if (event.data.type === "need-script") resolve(event.data.url);
          else if (event.data.type === "probe-done") resolve(null);
        };
        probe.onerror = event => { event.preventDefault(); resolve(null); };
      });
      native_clear_timeout(timer);
      this.#controller.signal.removeEventListener("abort", abort);
      probe.terminate();
      URL.revokeObjectURL(blob);
      if (!missing || sources.has(missing)) break;
      sources.set(missing, false);
      try {
        const response = await network.fetch(missing, {signal: this.#controller.signal});
        if (!response.ok) continue;
        const script = await response.text();
        sources.set(missing, script);
        const final_url=response.url||missing;
        this.#source_urls.set(missing,final_url);
        await prefetch_worker_scripts(script, url, resource => network.fetch(resource, {signal: this.#controller.signal}), sources,this.#source_urls,final_url);
      } catch {}
    }
  }

  async #start() {
    const credentials = this.#options.type === "classic" ? "same-origin" : this.#options.credentials;
    const response = await network.fetch(this.#url, {credentials, signal: this.#controller.signal});
    if (!response.ok) throw new TypeError(`Worker request failed: ${response.status}`);
    const source = await response.text();
    const url = response.url || this.#url;
    let sources = new Map();
    if (this.#options.type === "classic") {
      const prefetched = await prefetch_worker_scripts(source, url, resource => network.fetch(resource, {signal: this.#controller.signal}),sources,this.#source_urls);
      sources = prefetched.cache;
      if (prefetched.dynamic) await this.#probe(source, url, sources);
    }
    if (this.#terminated) return;
    const register = rpc.create_rpc_wrapper(rpc.host, "frame_register");
    const registration = await register(loader.frame_id, this.#id, url, {worker: true});
    this.#registered = true;
    if (this.#terminated) { this.#unregister(); return; }
    this.#bootstrap = this.#blob({...this.#payload(source, url, sources),beacon_context:registration.beacon_context});
    // A classic bootstrap can import worker-local module blobs even on file:
    // origins, where native module-worker construction rejects parent blobs.
    this.#worker = new NativeWorker(this.#bootstrap, {...this.#options, type: "classic"});
    this.#worker.onmessage = event => {
      if (event.data?.sandstone_worker === this.#token) {
        if (event.data.type === "closed") this.terminate();
        else if (event.data.type === "error") {
          this.#error(Object.assign(new Error(event.data.message), {name: event.data.name, stack: event.data.stack}));
          this.terminate();
        }
        return;
      }
      this.dispatchEvent(new NativeMessageEvent("message", {data: event.data, ports: [...event.ports]}));
    };
    this.#worker.onmessageerror = event => this.dispatchEvent(new NativeMessageEvent("messageerror", {data: event.data}));
    this.#worker.onerror = event => { event.preventDefault(); this.#error(event.error || new Error(event.message)); };
    const channel = new MessageChannel();
    rpc.attach_host(channel.port1, this.#id);
    rpc.set_host(this.#worker, channel.port2,{nonce:this.#bootstrap_nonce});
    this.#worker.postMessage({sandstone_worker: this.#token, type: "connect"}, [this.#receiver]);
    this.#receiver = null;
  }

  postMessage(message, transfer) {
    if (!this.#terminated) this.#port.postMessage(message, transfer);
  }

  #unregister() {
    if (!this.#registered) return;
    this.#registered = false;
    rpc.create_rpc_wrapper(rpc.host, "frame_unregister")(this.#id).catch(() => {});
  }

  terminate() {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#controller.abort();
    this.#worker?.terminate();
    this.#port.close();
    this.#receiver?.close();
    this.#unregister();
    if (this.#bootstrap) URL.revokeObjectURL(this.#bootstrap);
    this.#removeUnload?.();
  }
  get [Symbol.toStringTag]() { return "Worker"; }
}
