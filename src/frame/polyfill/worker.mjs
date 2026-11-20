import * as network from "../network.mjs";
import * as loader from "../loader.mjs";
import * as rpc from "../../rpc.mjs";
import {bootstrap_worker,create_bootstrap_nonce} from '../../bootstrap.mjs';
import * as parser from "../parser.mjs";
import { ctx, ctx_vars, update_ctx, convert_url } from "../context.mjs";
import { modules,evaluate_worker_module } from "./module.mjs";
import { prefetch_worker_scripts } from "../worker_scripts.mjs";
import {create_worker_script_loader} from '../worker_loader.mjs';
import {create_sync_http_client,create_sync_http_server} from '../../sync_http.mjs';
import {snapshot_sync_body,restore_sync_body} from '../../sync_http_body.mjs';
import {serialize_request} from './request.mjs';
import {on_document_unload} from '../runtime_events.mjs';
import {document_referrer_policy} from '../intercept/document.mjs';
import {parse_referrer_policy,default_referrer_policy} from '../../referrer.mjs';
import {validate_module_response} from '../modules.mjs';
import {create_service_worker_runtime,install_service_worker_globals} from '../../service_worker/runtime.mjs';
import {bind_native_property} from '../global_functions.mjs';
import {ServiceWorkerScripts} from '../../service_worker/scripts.mjs';
import {encode_message} from './crypto.mjs';
import {configure_service_worker_scripts,service_worker_script_snapshot,remember_service_worker_script} from '../service_worker_scripts.mjs';

const NativeWorker = globalThis.Worker;
const native_import_scripts = globalThis.importScripts?.bind(globalThis);
const native_post = globalThis.postMessage?.bind(globalThis);
const NativeXHR = globalThis.XMLHttpRequest;
const NativeSharedBuffer=globalThis.SharedArrayBuffer;
const native_isolated=globalThis.crossOriginIsolated===true;
const NativeMessageEvent=globalThis.MessageEvent,NativeErrorEvent=globalThis.ErrorEvent;
const native_timeout=globalThis.setTimeout.bind(globalThis),native_clear_timeout=globalThis.clearTimeout.bind(globalThis);
const native_dispatch=globalThis.dispatchEvent?.bind(globalThis);
const imported_blobs = new Map();
const service_profile=Symbol('private service worker profile');
export function create_service_worker(profile){
  if(typeof profile?.source!=='string')throw new TypeError('A validated service worker script is required');
  return new FakeWorker(profile.scriptURL,{type:profile.type||'classic',[service_profile]:profile});
}
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
let sync_client;
export function sync_worker_available(url){
  if(!worker_options||worker_options.service_worker||worker_options.probe)return false;
  return !!(NativeXHR&&/^(?:data|blob):/.test(url)||worker_options.sync_http&&NativeSharedBuffer);
}
export function sync_worker_request(url,options,timeout){
  if(!sync_worker_available(url))throw new DOMException('Synchronous relay transport is unavailable','InvalidAccessError');
  if(/^(?:data|blob):/.test(url)){
    const request=new NativeXHR();request.open(options.method,url,false);request.responseType='arraybuffer';request.timeout=timeout;
    request.withCredentials=options.credentials==='include';for(const [name,value] of options.headers)request.setRequestHeader(name,value);request.send(options.body);
    const headers=request.getAllResponseHeaders().trim().split(/[\r\n]+/).filter(Boolean).map(line=>{const index=line.indexOf(':');return [line.slice(0,index),line.slice(index+1).trim()];});
    return {status:request.status,statusText:request.statusText,url:request.responseURL||url,headers,bytes:new Uint8Array(request.response||new ArrayBuffer(0))};
  }
  sync_client??=create_sync_http_client({SharedBuffer:NativeSharedBuffer,post:packet=>native_post({sandstone_worker:worker_options.token,...packet})});
  return sync_client(url,{...options,body:snapshot_sync_body(options.body)},timeout);
}
let callback_script_loader;
export function load_worker_scripts(...args){
  callback_script_loader??=create_worker_script_loader({cache:network.resource_cache,
    resolve:path=>convert_url(String(path),loader.url),base:()=>loader.url,execute:fakeImportScripts,
    fetch:url=>network.fetch(url,{mode:'no-cors',credentials:'include',destination:'script',referrer:loader.url,referrerPolicy:loader.referrer_policy}),
    remember(url,response){
      (worker_options.source_urls??={})[url]=response.url||url;
      (worker_options.source_cross_origins??={})[url]=response.request_cross_origin??response.type==='opaque';
    }
  });
  return callback_script_loader(...args);
}
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
    if(source===undefined&&worker_options?.service_worker?.restoring)throw new DOMException('Script is absent from the installed service worker','NetworkError');
    if (source === undefined && /^(data|blob):/.test(url) && NativeXHR) {
      const request = new NativeXHR();
      request.open("GET", url, false);
      request.send();
      source = request.responseText;
      if(worker_options?.service_worker){
        const headers={};const mime=request.getResponseHeader('content-type');if(mime)headers['content-type']=mime;
        try{validate_module_response(new Response(source,{headers}),'javascript',url);}catch{throw new DOMException('Invalid imported service worker script','NetworkError');}
        remember_service_worker_script({url,source,headers:[...new Headers(headers)]});
      }
      network.cache_put(url, source);
    }
    if (source === undefined && worker_options?.probe) {
      native_post({sandstone_worker: worker_options.token, type: "need-script", url});
      throw new DOMException("Worker discovery needs a script", "NetworkError");
    }
    if (typeof source !== "string") throw new DOMException(`Worker script is unavailable: ${url}`, "NetworkError");
    if (!imported_blobs.has(url)) {
      const scriptURL=worker_options?.source_urls?.[url]||url;
      const crossed=worker_options?.source_cross_origins?.[url]??new URL(scriptURL).origin!==ctx.origin;
      const rewritten = parser.rewrite_js(source, {url:scriptURL,sourceURL:scriptURL,workerLoaders:!worker_options?.probe&&!worker_options?.service_worker,importReferrer:{url:crossed?'about:blank':scriptURL,credentials:'same-origin',referrerPolicy:loader.referrer_policy}});
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
  if(options.service_worker)configure_service_worker_scripts(options.service_worker);
  const service=options.service_worker&&create_service_worker_runtime({profile:options.service_worker,target:ctx.self,Request:ctx.Request,encode:encode_message,scripts:service_worker_script_snapshot,send:(packet,ports)=>native_post({sandstone_service_worker:options.token,...packet},ports)});
  if(service){
    install_service_worker_globals(service,{target:ctx.self,names:ctx_vars});
    for(const type of ['install','activate','fetch','message','messageerror'])bind_native_property(ctx.self,'on'+type);
  }
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
        await evaluate_worker_module(await modules.prepare_url(options.url, options.url));
      } else {
        // Native classic-script evaluation preserves strict globals and lexical
        // bindings across imported files; indirect eval gives them another scope.
        fakeImportScripts(options.url);
      }
      mark_worker_started();
      service?.start();
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
    port.onmessage = event => { if(service)void service.receive(event.data);else{message_queue.push(event);pump();} };
    port.onmessageerror = event => { message_queue.push(event); pump(); };
    port.start();
    start();
  };
  globalThis.addEventListener("message", connect);
  const native_close = globalThis.close.bind(globalThis);
  if(service){
    for(const name of ['postMessage','close','Worker','DedicatedWorkerGlobalScope']){
      let owner=globalThis;while(owner){Reflect.deleteProperty(owner,name);owner=Object.getPrototypeOf(owner);}
    }
  }else replace_worker_method('close',() => {
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
  #source_cross_origins=new Map();
  #referrerPolicy;
  #serviceProfile;
  #serviceScripts;
  #syncServer;

  constructor(url, options = {}) {
    super();
    this.#serviceProfile=options[service_profile];
    if(this.#serviceProfile)this.#serviceScripts=new ServiceWorkerScripts(this.#serviceProfile.scripts,{restoring:!!this.#serviceProfile.restoring});
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
    this.#referrerPolicy=document_referrer_policy();
    this.#start().catch(error => { if (!this.#terminated) { this.#error(error); this.terminate(); } });
  }

  #error(error) {
    const event = new NativeErrorEvent("error", {message: error.message, filename: this.#url, error, cancelable: true});
    if (this.dispatchEvent(event)) console.error(error);
  }

  #payload(source, url, sources, probe = false) {
    return {
      source:sources.get(url)===source?undefined:source, url, sources: Object.fromEntries(sources), source_urls:Object.fromEntries(this.#source_urls),source_cross_origins:Object.fromEntries(this.#source_cross_origins),probe,
      frame_id: this.#id, token: this.#token, type: this.#options.type,
      credentials: this.#options.credentials, runtime_src: loader.runtime_src,sync_http:!!(NativeSharedBuffer&&native_isolated),
      crypto_available: loader.crypto_available,
      referrer_policy: this.#referrerPolicy,
      origin: new URL(url).protocol === "data:" ? "null" : ctx.origin,
      ...(this.#serviceProfile?{service_worker:{scope:this.#serviceProfile.scope,scriptURL:this.#url,updateViaCache:this.#serviceProfile.updateViaCache||'imports',restoring:!!this.#serviceProfile.restoring,scripts:this.#serviceScripts.snapshot()}}:{})
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
        const response = await this.#fetch_script(missing,url);
        if (!response.ok) continue;
        const script = await response.text();
        sources.set(missing, script);
        const final_url=response.url||missing;
        this.#source_urls.set(missing,final_url);
        await prefetch_worker_scripts(script, url, resource => this.#fetch_script(resource,url), sources,this.#source_urls,final_url);
      } catch {}
    }
  }

  async #fetch_script(resource,url){
    const options={signal:this.#controller.signal,mode:'no-cors',credentials:'include',destination:'script',referrer:url,referrerPolicy:this.#referrerPolicy,...(/^https?:/.test(resource)?{sandstone_worker_script:this.#id}:{})};
    const response=await(this.#serviceScripts?this.#serviceScripts.fetch(resource,options,'javascript',network.fetch):network.fetch(resource,options));
    this.#source_cross_origins.set(resource,response.request_cross_origin??response.type==='opaque');
    return response;
  }

  async #start() {
    const credentials = this.#options.type === "classic" ? "same-origin" : this.#options.credentials;
    const serviceEntry=this.#serviceProfile?{url:this.#url,headers:[['content-type','text/javascript'],['referrer-policy',this.#serviceProfile.referrerPolicy||this.#referrerPolicy]],...this.#serviceScripts.entries.get(this.#url),source:this.#serviceProfile.source}:null;
    const response = serviceEntry?this.#serviceScripts.response(serviceEntry,'javascript'):await network.fetch(this.#url, {credentials,destination:'worker',referrerPolicy:this.#referrerPolicy,...(/^https?:/.test(this.#url)?{mode:'same-origin'}:{}), signal: this.#controller.signal});
    if (!response.ok) throw new TypeError(`Worker request failed: ${response.status}`);
    if(this.#options.type==='module')validate_module_response(response,'javascript',this.#url);
    const network_script=/^https?:/.test(response.url||this.#url);
    this.#referrerPolicy=parse_referrer_policy(response.headers.get('referrer-policy'),network_script?default_referrer_policy:this.#referrerPolicy);
    const source = await response.text();
    const url = response.url || this.#url;
    if(this.#serviceScripts)this.#serviceScripts.set({...serviceEntry,url,source,responseURL:url,status:response.status,statusText:response.statusText,headers:[...response.headers],redirected:response.redirected,request_cross_origin:false});
    if (this.#terminated) return;
    const register = rpc.create_rpc_wrapper(rpc.host, "frame_register");
    const registration = await register(loader.frame_id, this.#id, url, {worker: true});
    this.#registered = true;
    if (this.#terminated) { this.#unregister(); return; }
    this.#source_cross_origins.set(url,false);
    let sources = new Map();
    if(this.#serviceScripts)for(const script of this.#serviceScripts.snapshot()){
      if(this.#options.type==='classic')this.#serviceScripts.response(script,'javascript');
      if(this.#serviceProfile.restoring)sources.set(script.url,script.source);
      this.#source_urls.set(script.url,script.responseURL||script.url);
      this.#source_cross_origins.set(script.url,script.request_cross_origin??new URL(script.responseURL||script.url).origin!==ctx.origin);
    }
    if (this.#options.type === "classic") {
      const prefetched = await prefetch_worker_scripts(source, url, resource => this.#fetch_script(resource,url),sources,this.#source_urls);
      sources = prefetched.cache;
      if (prefetched.dynamic&&!this.#serviceProfile?.restoring) await this.#probe(source, url, sources);
    }
    if (this.#terminated) return;
    this.#bootstrap = this.#blob({...this.#payload(source, url, sources),beacon_context:registration.beacon_context});
    // A classic bootstrap can import worker-local module blobs even on file:
    // origins, where native module-worker construction rejects parent blobs.
    this.#worker = new NativeWorker(this.#bootstrap, {...this.#options, type: "classic"});
    if(NativeSharedBuffer&&native_isolated)this.#syncServer=create_sync_http_server({SharedBuffer:NativeSharedBuffer,fetch:async(url,options,signal)=>{
      const request=await serialize_request(url,{method:options.method,headers:options.headers,body:restore_sync_body(options.body),credentials:options.credentials,signal},this.#url);
      signal.throwIfAborted();return network.fetch(request.url,{...request.options,signal,sandstone_worker_request:this.#id,referrerPolicy:this.#referrerPolicy});
    }});
    this.#worker.onmessage = event => {
      if (event.data?.sandstone_worker === this.#token) {
        if(this.#syncServer?.receive(event.data))return;
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
    this.#syncServer?.close();
    this.#worker?.terminate();
    this.#port.close();
    this.#receiver?.close();
    this.#unregister();
    if (this.#bootstrap) URL.revokeObjectURL(this.#bootstrap);
    this.#removeUnload?.();
  }
  get [Symbol.toStringTag]() { return "Worker"; }
}
