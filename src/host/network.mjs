import { iframes } from "./controller.mjs";
import { rpc_handlers } from "../rpc.mjs";
import { libcurl } from "libcurl.js/bundled";
import { site_data } from "./site_data.mjs";
import { fetch_with_cookies } from "./request.mjs";
import { requests, request_key, cancel_requests } from "./streams.mjs";
import { streaming_http_session } from "./http_session.mjs";
import { relay_websocket_class, websocket_options } from "./websocket.mjs";
import { BeaconQueue } from './beacon.mjs';

export const ws_connections = {};
export let session = null;
export const beacons = new BeaconQueue({fetch: (...args) => fetch(...args), cookies: url => site_data.documentCookies(url)});
rpc_handlers.beacon = (context, url, body, options) => beacons.send(context, url, body, options);

export async function fetch(url, options, context) {
  return fetch_with_cookies((url, init) => session.fetch(url, init), site_data, url, options, context);
}

export function set_websocket(url) {
  libcurl.set_websocket(url);
}

function get_ws(frame_id, ws_id) {
  let frame_websockets = ws_connections[frame_id];
  if (!frame_websockets) return;
  return frame_websockets[ws_id];
}

//handle fetch api requests
rpc_handlers["fetch"] = async function(frame_id, request_id, url, options) {
  const frame = iframes[frame_id];
  if (!frame) throw new TypeError("Unknown frame");
  const key = request_key(frame_id, request_id);
  const request = {frame_id, controller: new AbortController(), reader: null};
  requests.set(key, request);
  let response;
  try {
    response = await fetch(url, {...options, signal: request.controller.signal}, {
      url: options?.mode === 'navigate' && frame.pending_navigation?.source_url || (frame.url.origin === "null" && frame.origin && frame.origin !== "null" ? frame.origin + "/" : frame.url.href),
      top_url: iframes[frame.root_id]?.url?.href || frame.url.href,
      navigation: options?.mode === 'navigate', nested: true
    });
    request.reader = response.body?.getReader();
  } catch (error) {
    requests.delete(key);
    throw error;
  }
  var keys = ["ok", "redirected", "status", "statusText", "type", "url"];
  var payload = {
    request_referrer: response.request_referrer,
    has_body: !!request.reader,
    headers: [],
    items: {},
    cookies: site_data.documentCookies(frame.url.href)
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
  const source = frame.url.origin === 'null' && frame.origin && frame.origin !== 'null' ? frame.origin + '/' : frame.url.href;
  const options = websocket_options(site_data, url, {
    url: source, top_url: iframes[frame.root_id]?.url.href || source, userAgent: navigator.userAgent
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
      if (event_name === 'open') data = {protocol: ws.protocol || '', cookies: site_data.documentCookies(source)};
      if (event_name === 'error') data = {cookies: site_data.documentCookies(source)};
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
export function clean_ws_connections(id_to_clean) {
  beacons.retire(id_to_clean);
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
