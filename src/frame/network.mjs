import * as rpc from "../rpc.mjs";
import * as loader from "./loader.mjs";
import { create_websocket_class } from "./websocket.mjs";
import { ctx } from "./context.mjs";
import { load_cookies } from "./polyfill/cookie.mjs";

export const rpc_fetch = rpc.create_rpc_wrapper(rpc.host, "fetch");
const rpc_fetch_read = rpc.create_rpc_wrapper(rpc.host, "fetch_read");
const rpc_fetch_abort = rpc.create_rpc_wrapper(rpc.host, "fetch_abort");
export const rpc_ws_new = rpc.create_rpc_wrapper(rpc.host, "ws_new");
export const rpc_ws_event = rpc.create_rpc_wrapper(rpc.host, "ws_event");
export const rpc_ws_send = rpc.create_rpc_wrapper(rpc.host, "ws_send");
export const rpc_ws_close = rpc.create_rpc_wrapper(rpc.host, "ws_close");

export const known_urls = {};
export const resource_cache = {};
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
  if (url.protocol === "data:" || url.protocol === "blob:") {
    return await globalThis.fetch(url.href, options);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw TypeError("Invalid URL");
  }

  const params = {...options};
  const signal = params.signal;
  delete params.signal;
  signal?.throwIfAborted();
  const request_id = Math.random() + "";
  let stream_controller;
  const cleanup = () => signal?.removeEventListener("abort", abort);
  const abort = () => {
    rpc_fetch_abort(loader.frame_id, request_id).catch(() => {});
    stream_controller?.error(signal.reason);
    cleanup();
  };
  signal?.addEventListener("abort", abort, {once: true});
  try {
    const pending = rpc_fetch(loader.frame_id, request_id, url.href, params);
    const fetch_data = signal ? await new Promise((resolve, reject) => {
      const reject_abort = () => reject(signal.reason);
      signal.addEventListener("abort", reject_abort, {once: true});
      pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", reject_abort));
    }) : await pending;
    signal?.throwIfAborted();
    load_cookies(fetch_data.cookies);
    const body = fetch_data.has_body ? new ReadableStream({
      start(controller) { stream_controller = controller; },
      async pull(controller) {
        try {
          const chunk = await rpc_fetch_read(loader.frame_id, request_id);
          if (chunk.done) { cleanup(); controller.close(); }
          else controller.enqueue(chunk.value);
        } catch (error) { cleanup(); controller.error(error); }
      },
      cancel() { cleanup(); return rpc_fetch_abort(loader.frame_id, request_id); }
    }) : null;
    if (!body) { cleanup(); await rpc_fetch_abort(loader.frame_id, request_id); }
    return restore_response({...fetch_data, body});
  } catch (error) { cleanup(); throw error; }
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
  const clone = response.clone.bind(response);
  Object.defineProperty(response, "clone", {value: () => {
    const copy = clone();
    return restore_response({...data, body: copy.body});
  }});
  return response;
}

export function create_blob_url(blob, target_url = null) {
  let url = URL.createObjectURL(blob);
  if (target_url)
    known_urls[url] = target_url;
  return url;
}

export const WebSocket = create_websocket_class({
  base: () => ctx.document?.baseURI || ctx.location.href,
  connect: (url, protocols) => rpc_ws_new(loader.frame_id, url, protocols, {
    headers: {Origin: ctx.location.origin, 'User-Agent': navigator.userAgent}
  }),
  events: id => rpc_ws_event(loader.frame_id, id),
  send: (id, data) => rpc_ws_send(loader.frame_id, id, data),
  close: id => rpc_ws_close(loader.frame_id, id)
});