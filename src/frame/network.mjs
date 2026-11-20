import * as rpc from "../rpc.mjs";
import * as loader from "./loader.mjs";
import { create_websocket_class } from "./websocket.mjs";
import { ctx } from "./context.mjs";
import { load_cookies } from "./polyfill/cookie.mjs";
import {document_referrer_policy} from './intercept/document.mjs';
import {reserve_keepalive} from './keepalive_budget.mjs';
import {remember_response} from '../response_metadata.mjs';
import {ResourcePreloads} from '../preloads.mjs';
const native_fetch=globalThis.fetch;
const preloads=new ResourcePreloads();
export function preload_resource(url,options){return preloads.load(url,options,loader.beacon_context,()=>fetch(url,{...options,sandstone_preload:true}));}
const navigation_data=new WeakMap(),metadata_get=WeakMap.prototype.get,metadata_set=WeakMap.prototype.set,apply=Reflect.apply;
const worker_data=new WeakMap();
export function worker_context(response){return apply(metadata_get,worker_data,[response]);}
export function navigation_metadata(response){return apply(metadata_get,navigation_data,[response]);}

export const rpc_fetch = rpc.create_rpc_wrapper(rpc.host, "fetch");
const rpc_worker_script=rpc.create_rpc_wrapper(rpc.host,'fetch_worker_script');
const rpc_worker_request=rpc.create_rpc_wrapper(rpc.host,'fetch_worker_request');
const rpc_fetch_read = rpc.create_rpc_wrapper(rpc.host, "fetch_read");
const rpc_fetch_abort = rpc.create_rpc_wrapper(rpc.host, "fetch_abort");
const rpc_keepalive = rpc.create_rpc_wrapper(rpc.host,'fetch_keepalive');
const rpc_keepalive_read = rpc.create_rpc_wrapper(rpc.host,'fetch_keepalive_read');
const rpc_keepalive_abort = rpc.create_rpc_wrapper(rpc.host,'fetch_keepalive_abort');
const rpc_keepalive_done = rpc.create_rpc_wrapper(rpc.host,'fetch_keepalive_done');
export const rpc_ws_new = rpc.create_rpc_wrapper(rpc.host, "ws_new");
export const rpc_ws_event = rpc.create_rpc_wrapper(rpc.host, "ws_event");
export const rpc_ws_send = rpc.create_rpc_wrapper(rpc.host, "ws_send");
export const rpc_ws_close = rpc.create_rpc_wrapper(rpc.host, "ws_close");

export const known_urls = Object.create(null);
export const resource_cache = {};
export const stylesheet_contexts = {};
export let requests_allowed = false;

export function enable_network(allowed=true) {
  requests_allowed = allowed;
}

export function cache_put(url, data) {
  resource_cache[url] = data; //put a blob into the cache
}

export async function fetch(url, options) {
  if (!requests_allowed) throw "Network request blocked";

  let base_url = ctx.location?.href || loader.url;
  url = new URL(url, base_url);
  if(!options?.sandstone_preload&&!options?.sandstone_worker_script&&!options?.sandstone_worker_request&&!options?.sandstone_frame_id){
    options?.signal?.throwIfAborted();const cached=preloads.consume(url.href,options||{},loader.beacon_context);
    if(cached){
      const signal=options?.signal;let abort;
      try{const response=signal?await Promise.race([cached,new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});})]):await cached;signal?.throwIfAborted();if(response)return response;}
      finally{if(abort)signal.removeEventListener('abort',abort);}
    }
  }
  if (url.protocol === "data:" || url.protocol === "blob:") {
    try { return await native_fetch(url.href, options); }
    finally { options?.sandstone_keepalive_release?.(); }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw TypeError("Invalid URL");
  }

  const params = {...options};
  delete params.sandstone_preload;
  const reserved_release = params.sandstone_keepalive_release;
  delete params.sandstone_keepalive_release;
  if (!params.referrerPolicy) params.referrerPolicy = document_referrer_policy();
  const worker_script=params.sandstone_worker_script;
  delete params.sandstone_worker_script;
  const worker_request=params.sandstone_worker_request;delete params.sandstone_worker_request;
  const frame_id = worker_script || worker_request || params.sandstone_frame_id || loader.frame_id;
  delete params.sandstone_frame_id;
  const navigation_source=params.sandstone_navigation_source;
  delete params.sandstone_navigation_source;
  const signal = params.signal;
  delete params.signal;
  signal?.throwIfAborted();
  const request_id = Math.random() + "";
  const keepalive = !!params.keepalive;
  if(worker_script&&keepalive)throw new TypeError('Worker script prefetch cannot be keepalive');
  const owner = keepalive ? loader.beacon_context : frame_id;
  const open = worker_script ? (...args)=>rpc_worker_script(loader.frame_id,...args) : worker_request ? (...args)=>rpc_worker_request(loader.frame_id,...args) : keepalive ? rpc_keepalive : rpc_fetch;
  const read = keepalive ? rpc_keepalive_read : rpc_fetch_read;
  const cancel = keepalive ? rpc_keepalive_abort : rpc_fetch_abort;
  const bytes = keepalive && params.body != null ? new Blob([params.body]).size : 0;
  const release = reserved_release || (keepalive ? reserve_keepalive(bytes) : ()=>{});
  let stream_controller;
  const cleanup = () => signal?.removeEventListener("abort", abort);
  const abort = () => {
    cancel(owner, request_id).catch(() => {});
    stream_controller?.error(signal.reason);
    cleanup();
  };
  signal?.addEventListener("abort", abort, {once: true});
  try {
    const pending = open(owner, request_id, url.href, params,navigation_source);
    if (keepalive) pending.then(()=>rpc_keepalive_done(owner,request_id)).then(release,release);
    const fetch_data = signal ? await new Promise((resolve, reject) => {
      const reject_abort = () => reject(signal.reason);
      signal.addEventListener("abort", reject_abort, {once: true});
      pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", reject_abort));
    }) : await pending;
    signal?.throwIfAborted();
    if (frame_id === loader.frame_id) load_cookies(fetch_data.cookies);
    const body = fetch_data.has_body ? new ReadableStream({
      start(controller) { stream_controller = controller; },
      async pull(controller) {
        try {
          const chunk = await read(owner, request_id);
          if (chunk.done) { cleanup(); controller.close(); }
          else controller.enqueue(chunk.value);
        } catch (error) { cleanup(); controller.error(error); }
      },
      cancel() { cleanup(); return cancel(owner, request_id); }
    }) : null;
    if (!body) { cleanup(); if (!keepalive) await cancel(owner, request_id); }
    return restore_response({...fetch_data, body});
  } catch (error) { cleanup(); release(); throw error; }
};

function restore_response(data) {
  const {status, statusText, url, redirected, type} = data.items;
  const response = new Response([101, 204, 205, 304].includes(status) ? null : data.body, {
    status: status >= 200 && status <= 599 ? status : 200,
    statusText, headers: data.headers
  });
  for (const [key, value] of Object.entries({url, redirected, type})) {
    Object.defineProperty(response, key, {value});
  }
  if(status===0)Object.defineProperties(response,{status:{value:0},ok:{value:false}});
  if (data.request_referrer !== undefined) Object.defineProperty(response,'request_referrer',{value:data.request_referrer});
  if(data.request_cross_origin!==undefined)Object.defineProperty(response,'request_cross_origin',{value:data.request_cross_origin});
  if(data.navigation_metadata)apply(metadata_set,navigation_data,[response,data.navigation_metadata]);
  if(data.worker_context)apply(metadata_set,worker_data,[response,data.worker_context]);
  const clone = response.clone.bind(response);
  Object.defineProperty(response, "clone", {value: () => {
    const copy = clone();
    return restore_response({...data, body: copy.body});
  }});
  return remember_response(response,data.items);
}

export function create_blob_url(blob, target_url = null, request_context = null) {
  let url = URL.createObjectURL(blob);
  if (target_url)
    known_urls[url] = target_url;
  if (request_context) stylesheet_contexts[url] = request_context;
  return url;
}

export const WebSocket = create_websocket_class({
  base: () => ctx.document?.baseURI || ctx.location.href,
  connect: (url, protocols) => rpc_ws_new(loader.frame_id, url, protocols),
  async events(id) {
    const batch = await rpc_ws_event(loader.frame_id, id);
    for (const [, data] of batch || []) if (data?.cookies) load_cookies(data.cookies);
    return batch;
  },
  send: (id, data) => rpc_ws_send(loader.frame_id, id, data),
  close: id => rpc_ws_close(loader.frame_id, id)
});
