import { iframes } from "./controller.mjs";
import { rpc_handlers } from "../rpc.mjs";
import { libcurl } from "libcurl.js/bundled";
import { site_data } from "./site_data.mjs";
import { fetch_with_cookies } from "./request.mjs";
import { requests, request_key, cancel_requests } from "./streams.mjs";
import { streaming_http_session } from "./http_session.mjs";

export const ws_connections = {};
export let session = null;

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
      url: frame.url.origin === "null" && frame.origin && frame.origin !== "null" ? frame.origin + "/" : frame.url.href
    });
    request.reader = response.body?.getReader();
  } catch (error) {
    requests.delete(key);
    throw error;
  }
  var keys = ["ok", "redirected", "status", "statusText", "type", "url"];
  var payload = {
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
rpc_handlers["ws_new"] = function (frame_id, url, protocols, options) {
  let ws_id = Math.random() + "";
  let ws = new libcurl.CurlWebSocket(url, protocols, options);
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
      ws_info.events.push([event_name, data]);
      ws_info.callback?.();
    }
  }

  //make sure ws is closed automatically
  let close_callback = ws.onclose;
  ws.onclose = (reason) => {
    close_callback(reason);
    ws.close();
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
    return ws_events;
  }
    
  return new Promise((resolve) => {
    ws_info.callback = () => {
      resolve(ws_info.events);
      ws_info.events = [];
      ws_info.callback = null;
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
}

//when navigating to a new page we need to close unused connections
export function clean_ws_connections(id_to_clean) {
  cancel_requests(id_to_clean);
  let frame_ids = Object.keys(iframes);
  
  for (let [frame_id, frame_websockets] of Object.entries(ws_connections)) {
    if (frame_ids.includes(frame_id) && frame_id !== id_to_clean) continue;
    
    for (let [ws_id, ws_info] of Object.entries(frame_websockets)) {
      delete ws_connections[frame_id][ws_id];
      ws_info.ws.close();
    }
    
    delete ws_connections[frame_id];
  }
}

libcurl.events.addEventListener("libcurl_load", () => {
  console.log(`libcurl.js v${libcurl.version.lib} loaded`);
  const HTTPSession = streaming_http_session(libcurl.HTTPSession);
  session = new HTTPSession({enable_cookies: false})
});
