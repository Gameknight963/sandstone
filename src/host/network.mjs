import { iframes } from "./controller.mjs";
import { rpc_handlers } from "../rpc.mjs";
import { libcurl } from "libcurl.js/bundled";
import { site_data } from "./site_data.mjs";
import { fetch_with_cookies } from "./request.mjs";
import { requests, request_key, cancel_requests } from "./streams.mjs";
import { streaming_http_session } from "./http_session.mjs";
import { relay_websocket_class, websocket_options } from "./websocket.mjs";
import { BeaconQueue } from './beacon.mjs';
import {KeepaliveRequests} from './keepalive.mjs';
import {http_cache} from './http_cache.mjs';
import {Downloads} from './download.mjs';
import {frame_cross_site,navigation_request_context,worker_script_frame} from './frame_context.mjs';
import {NavigationMetadata} from './navigation_metadata.mjs';
import {broadcast_channels} from './broadcast.mjs';
import {lock_service} from './locks.mjs';
import {disconnect_storage} from './storage.mjs';
import {cache_storage} from './cache.mjs';
import {file_system,disconnect_file_worker} from './filesystem.mjs';
export {http_cache} from './http_cache.mjs';
export {broadcast_channels};

export const ws_connections = {};
let service_worker_fetch,service_worker_disconnect,service_worker_bind,service_worker_navigation={};
let service_worker_request_context;
let worker_entries={};
export function set_worker_entries(callbacks){worker_entries=callbacks;}
export function commit_worker_client(frame,token){return worker_entries.commit?.(frame,token);}
export function reserved_worker_client(token){return worker_entries.reserved?.(token);}
export function set_service_worker_request_context(callback){service_worker_request_context=callback;}
export function set_service_worker_fetch(fetch,disconnect,bind,navigation={}){service_worker_fetch=fetch;service_worker_disconnect=disconnect;service_worker_bind=bind;service_worker_navigation=navigation;}
export function bind_service_worker_client(frame,signal){return service_worker_bind?.(frame,signal);}
export function navigation_client(response){return service_worker_navigation.response?.(response);}
export function commit_navigation_client(frame,lease){return service_worker_navigation.commit?.(frame,lease);}
export function cancel_navigation_client(target,owner,document){return service_worker_navigation.cancel?.(target,owner,document);}
export function reserved_navigation_client(id){return service_worker_navigation.reserved?.(id);}
export let session = null;
export const navigation_metadata=new NavigationMetadata(parent=>iframes[parent]?.document_context);
const context_cookies=(url,context)=>site_data.documentCookies(url,{crossSite:!!context?.cross_site});
export const beacons = new BeaconQueue({fetch: (...args) => fetch(...args), cookies: context_cookies});
export const keepalives = new KeepaliveRequests({queue:beacons,fetch:(...args)=>fetch(...args),cookies:context_cookies});
export const downloads=new Downloads({fetch:(...args)=>fetch(...args),contexts:beacons.contexts,cookies:context_cookies});
rpc_handlers.download_request=(...args)=>downloads.request(...args);
rpc_handlers.download_blob=(...args)=>downloads.blob(...args);
rpc_handlers.beacon = (context, url, body, options) => beacons.send(context, url, body, options);
rpc_handlers.fetch_keepalive = (...args) => keepalives.open(...args);
rpc_handlers.fetch_keepalive_read = (...args) => keepalives.read(...args);
rpc_handlers.fetch_keepalive_abort = (...args) => keepalives.abort(...args);
rpc_handlers.fetch_keepalive_done = (...args) => keepalives.completed(...args);

export async function fetch(url, options, context) {
  const transport=(url,options,context,worker)=>fetch_with_cookies((url,init)=>http_cache.fetch((url,init)=>session.fetch(url,init),url,init,context),site_data,url,options,context,worker);
  return service_worker_fetch?service_worker_fetch(url,options,context,transport):transport(url,options,context);
}

export function set_websocket(url) {
  libcurl.set_websocket(url);
}

function get_ws(frame_id, ws_id) {
  let frame_websockets = ws_connections[frame_id];
  if (!frame_websockets) return;
  return frame_websockets[ws_id];
}

rpc_handlers.fetch_worker_script=(parent_id,worker_id,request_id,url,options)=>{
  const worker=worker_script_frame(iframes,parent_id,worker_id);
  if(!/^https?:$/.test(new URL(url).protocol))throw new TypeError('Invalid worker script URL');
  return rpc_handlers.fetch(worker_id,request_id,url,{method:'GET',mode:'no-cors',credentials:'include',destination:'script',referrer:worker.url.href,referrerPolicy:options?.referrerPolicy});
};
rpc_handlers.fetch_worker_request=(parent_id,worker_id,request_id,url,options)=>{
  worker_script_frame(iframes,parent_id,worker_id);
  if(options?.mode==='navigate'||options?.keepalive)throw new TypeError('Invalid synchronous worker request');
  return rpc_handlers.fetch(worker_id,request_id,url,{...options,destination:'',mode:'cors',sandstone_request_context:undefined});
};
rpc_handlers.worker_entry_cancel=(parent,target)=>worker_entries.cancel?.(parent,target,iframes[parent]?.document_context);

//handle fetch api requests
rpc_handlers["fetch"] = async function(frame_id, request_id, url, options, navigation_source) {
  const frame = iframes[frame_id];
  if (!frame) throw new TypeError("Unknown frame");
  if(navigation_source&&options?.mode!=='navigate')throw new TypeError('Navigation source requires navigation mode');
  const source_context=navigation_source?{...navigation_request_context(beacons.contexts,navigation_source,frame.root_id),user_activation:!!options?.sandstone_navigation_activation}:{
    url: options?.mode === 'navigate' && frame.pending_navigation?.source_url || frame.request_url || (frame.url.origin === "null" && frame.origin && frame.origin !== "null" ? frame.origin + "/" : frame.url.href),
    top_url: iframes[frame.root_id]?.url?.href || frame.url.href,
    referrer_url:frame.referrer_url,
    broadcast_origin:frame.broadcast_origin,
    navigation: options?.mode === 'navigate',request_metadata:options?.mode==='navigate'&&frame.pending_navigation?.traversed?frame.history.current?.request_metadata:undefined,
    history_user_activation:options?.mode==='navigate'&&frame.pending_navigation?.traversed&&iframes[frame.root_id]?.history.current?.request_metadata?.user,
    user_activation:!!options?.sandstone_navigation_activation,nested:true,cross_site:frame_cross_site(frame,iframes),frame_id:frame.id,service_worker_client:frame.document_context
  };
  const key = request_key(frame_id, request_id);
  if(options?.sandstone_request_context){
    if(!service_worker_request_context)throw new DOMException('Unknown service worker request context','SecurityError');
    const snapshot=service_worker_request_context(frame_id,options.sandstone_request_context,url);
    Object.assign(source_context,snapshot,{navigation:snapshot.navigation&&options.mode==='navigate',frame_id:frame.id,service_worker_client:frame.document_context});
    if(options.referrer==='about:client')source_context.referrer_url=frame.referrer_url??frame.request_url??frame.url.href;
  }
  const metadataTarget=options?.sandstone_navigation_target,metadataFrame=iframes[metadataTarget];
  const metadataParent=metadataFrame
    ?(!metadataFrame.worker&&(metadataFrame.id===frame_id||metadataFrame.parent_id===frame_id)?metadataFrame.parent_id:undefined)
    :frame_id;
  const metadataScope=source_context.navigation&&metadataTarget&&metadataParent?navigation_metadata.capture(metadataParent,metadataTarget):undefined;
  if(metadataScope)Object.assign(source_context,{navigation_target:metadataTarget,navigation_owner:metadataParent,navigation_previous:metadataFrame?.document_context||frame.document_context,navigation_opaque:!!options?.sandstone_navigation_opaque});
  const request = {frame_id, controller: new AbortController(), reader: null};
  if(options?.sandstone_worker_entry){
    if(options.keepalive||options.mode!=='same-origin'||options.destination!=='worker'||options.method&&options.method!=='GET')throw new TypeError('Invalid worker entry request');
    source_context.worker_entry_target=options.sandstone_worker_entry;
  }
  requests.set(key, request);
  let response;
  try {
    const {sandstone_navigation_activation,sandstone_navigation_target,sandstone_navigation_opaque,sandstone_request_context,sandstone_worker_entry,...request_options}=options||{};
    response = await fetch(url, {...request_options, signal: request.controller.signal},source_context);
    request.reader = response.body?.getReader();
  } catch (error) {
    requests.delete(key);
    throw error;
  }
  var keys = ["ok", "redirected", "status", "statusText", "type", "url"];
  var payload = {
    request_referrer: response.request_referrer,
    request_cross_origin:response.request_cross_origin,
    worker_context:worker_entries.response?.(response),
    navigation_metadata:navigation_metadata.issue(metadataScope,response.url,response.request_metadata,navigation_client(response)),
    has_body: !!request.reader,
    headers: [],
    items: {},
    cookies: site_data.documentCookies(frame.cookie_url||frame.url.href,{crossSite:frame_cross_site(frame,iframes)})
  };  
  for (let key of keys) {
    payload.items[key] = response[key];
  }
  for (let pair of response.headers.entries()) {
    if (["set-cookie", "set-cookie2"].includes(pair[0].toLowerCase())) continue;
    payload.headers.push(pair);
  }

  return payload
}

rpc_handlers["fetch_read"] = async function(frame_id, request_id) {
  const key = request_key(frame_id, request_id);
  const request = requests.get(key);
  if (!request?.reader) return {done: true};
  try {
    const chunk = await request.reader.read();
    if (chunk.done) requests.delete(key);
    return chunk;
  } catch (error) {
    requests.delete(key);
    throw error;
  }
};

rpc_handlers["fetch_abort"] = function(frame_id, request_id) {
  const key = request_key(frame_id, request_id);
  const request = requests.get(key);
  if (!request) return;
  request.controller.abort();
  request.reader?.cancel().catch(() => {});
  requests.delete(key);
};

//handle websocket creation 
rpc_handlers["ws_new"] = function (frame_id, url, protocols) {
  let ws_id = Math.random() + "";
  const frame = iframes[frame_id];
  if (!frame) throw new TypeError('Unknown frame');
  const source = frame.request_url || (frame.url.origin === 'null' && frame.origin && frame.origin !== 'null' ? frame.origin + '/' : frame.url.href);
  const options = websocket_options(site_data, url, {
    url: source, top_url: iframes[frame.root_id]?.url.href || source, userAgent: navigator.userAgent,cross_site:frame_cross_site(frame,iframes),broadcast_origin:frame.broadcast_origin
  });
  const RelayWebSocket = relay_websocket_class(libcurl.CurlWebSocket);
  let ws = new RelayWebSocket(url, protocols, options);
  let ws_events = [];

  if (!ws_connections[frame_id]) ws_connections[frame_id] = {};
  ws_connections[frame_id][ws_id] = {
    ws: ws,
    events: ws_events,
    callback: null
  };
  let ws_info = ws_connections[frame_id][ws_id];
  
  //set up event listeners to forward to the frame
  for (let event_name of ["open", "message", "close", "error"]) {
    ws["on" + event_name] = (data) => {
      if (event_name === 'open') data = {protocol: ws.protocol || '', cookies: site_data.documentCookies(source,{crossSite:frame_cross_site(frame,iframes)})};
      if (event_name === 'error') data = {cookies: site_data.documentCookies(source,{crossSite:frame_cross_site(frame,iframes)})};
      if (event_name === 'close' || event_name === 'error') ws_info.ended = true;
      ws_info.events.push([event_name, data]);
      ws_info.callback?.();
    }
  }

  return ws_id;
}

//the frame will call this repeatedly to poll for new events
rpc_handlers["ws_event"] = function (frame_id, ws_id) {
  let ws_info = get_ws(frame_id, ws_id);
  if (!ws_info) return null;
  if (ws_info.events.length > 0) {
    let ws_events = ws_info.events;
    ws_info.events = [];
    if (ws_info.ended) delete ws_connections[frame_id][ws_id];
    return ws_events;
  }
    
  return new Promise((resolve) => {
    ws_info.callback = () => {
      resolve(ws_info.events);
      ws_info.events = [];
      ws_info.callback = null;
      if (ws_info.ended) delete ws_connections[frame_id][ws_id];
    }
  })
}

rpc_handlers["ws_send"] = function (frame_id, ws_id, data) {
  let ws_info = get_ws(frame_id, ws_id);
  if (!ws_info) return;
  ws_info.ws.send(data);
}

rpc_handlers["ws_close"] = function (frame_id, ws_id) {
  let ws_info = get_ws(frame_id, ws_id);
  if (!ws_info) return;
  delete ws_connections[frame_id][ws_id];
  ws_info.ws.close();
  ws_info.callback?.();
}

//when navigating to a new page we need to close unused connections
export function clean_ws_connections(id_to_clean,options={}) {
  service_worker_disconnect?.(id_to_clean,options);
  cache_storage.disconnect(id_to_clean);
  disconnect_storage(id_to_clean);
  broadcast_channels.disconnect(id_to_clean);
  lock_service.disconnect(id_to_clean);
  for(const [token,entry] of beacons.contexts)if(entry.frame===id_to_clean){disconnect_file_worker(token);file_system.release(token);}
  beacons.retire(id_to_clean);
  keepalives.retire(id_to_clean);
  cancel_requests(id_to_clean);
  let frame_ids = Object.keys(iframes);
  
  for (let [frame_id, frame_websockets] of Object.entries(ws_connections)) {
    if (frame_ids.includes(frame_id) && frame_id !== id_to_clean) continue;
    
    for (let [ws_id, ws_info] of Object.entries(frame_websockets)) {
      delete ws_connections[frame_id][ws_id];
      ws_info.ws.close();
      ws_info.callback?.();
    }
    
    delete ws_connections[frame_id];
  }
}

libcurl.events.addEventListener("libcurl_load", () => {
  console.log(`libcurl.js v${libcurl.version.lib} loaded`);
  const HTTPSession = streaming_http_session(libcurl.HTTPSession);
  session = new HTTPSession({enable_cookies: false})
});
