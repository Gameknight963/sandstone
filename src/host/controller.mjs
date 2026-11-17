import * as rpc from "../rpc.mjs";
import * as util from "../util.mjs";
import * as network from "./network.mjs";
import { site_data } from "./site_data.mjs";
import { indexed_db } from "./indexeddb.mjs";
import {crypto_service} from './crypto.mjs';
import { NavigationHistory } from "../history.mjs";
import {parse_referrer_policy,default_referrer_policy} from '../referrer.mjs';
export { site_data } from "./site_data.mjs";
export { indexed_db } from "./indexeddb.mjs";

import { version } from "./index.mjs";

import { libcurl } from "libcurl.js/bundled";

//frame_js is a string, which is imported using webpack
import frame_js from "../../dist/sandstone_frame.js";

let frame_url = null;
let frame_html = `
  <!DOCTYPE html>
  <head>
    <meta charset="utf-8">
    <script>${frame_js}</script>
    <style>
      html {
        background-color: #222222;
        font-family: sans-serif;
      }
      * {
        color: #dddddd;
      }
      #error_div {
        display: none;
      }
      #version_text {
        font-size: 14px;
      }
    </style>
  </head>
  <body>
    <p id="loading_text">Loading...</p>

    <div id="error_div">
      <h2>An unexpected error has occurred</h2>
      <pre id="error_msg">
      </pre>
      <p><i>
        <span id="version_text"></span>
      </p></i>
    </div>
  </body>
`;

export const iframes = {};
const saved_child_histories = new Map();
export const persist_storage_key = "proxy_local_storage";
export let local_storage = {};
local_storage = site_data.local;

function get_frame_bundle() {
  if (!frame_url) {
    let frame_blob = new Blob([frame_html], {type: "text/html"});
    frame_url = URL.createObjectURL(frame_blob);
  }
  return frame_url;
}

export class ProxyFrame {
  get origin() { return this.url?.origin; }
  constructor() {
    this.url = null;
    this.is_navigating = false;
    this.navigation_id = 0;
    this.session_storage = Object.create(null);
    this.history = new NavigationHistory();
    this.id = Math.random() + "";
    this.root_id = this.id;
    this.iframe = document.createElement("iframe");
    this.iframe.sandbox = "allow-scripts allow-forms allow-modals allow-pointer-lock";
    this.iframe.allowFullscreen = true;
    this.iframe.setAttribute("frame-id", this.id);

    iframes[this.id] = this;
    this.rpc_target = new rpc.RPCTarget();
    this.rpc_target.onmessage = rpc.message_listener;
    this.send_page = rpc.create_rpc_wrapper(this.rpc_target, "html");
    this.get_favicon = rpc.create_rpc_wrapper(this.rpc_target, "favicon");
    this.eval_js = rpc.create_rpc_wrapper(this.rpc_target, "eval");

    this.on_navigate = () => {};
    this.on_load = () => {};
    this.on_url_change = () => {};

    this.special_pages = {};
    this.site_settings = [];
    this.default_settings = {
      allow_js: true
    };
  }

  async wait_for_libcurl() {
    if (libcurl.ready) return;
    await libcurl.load_wasm();
  }

  async navigate_to(url, form_data=null, navigation = {}) {
    if (!util.is_valid_url(url)) throw TypeError("Invalid URL");
    const navigation_id = ++this.navigation_id;
    this.is_navigating = true;
    await this.wait_for_libcurl();
    if (navigation_id !== this.navigation_id) return;
    if (!util.is_valid_url(url)) {
      throw TypeError("Invalid URL");
    }

    console.log("navigating to", url);
    if (navigation_id !== this.navigation_id) return;
    const source_url = navigation.initiated ? this.url?.href : undefined;
    const source_policy = navigation.referrerPolicy || this.referrer_policy || default_referrer_policy;
    this.url = new URL(url);
    
    this.iframe.style.backgroundColor = "#222222";
    this.history.save_scroll(navigation.scroll);
    this.on_navigate();
    this.iframe.src = get_frame_bundle();
    indexed_db.disconnect(this.id);
    network.clean_ws_connections(this.id);
    for (const [id, frame] of Object.entries(iframes)) {
      if (frame.root_id === this.id && id !== this.id) {
        indexed_db.disconnect(id);
        network.clean_ws_connections(id);
        delete iframes[id];
      }
    }
    for (const [id, saved] of saved_child_histories) {
      if (saved.root_id === this.id) saved_child_histories.delete(id);
    }

    let html = null;
    let error = false;
    let referrer_policy = default_referrer_policy, document_referrer = '';

    if (typeof this.special_pages[url] === "string") {
      html = this.special_pages[url];
    }
    else {
      try {
        let options = {};
        if (form_data) {
          console.log("placing post request:", form_data);
          options = {
            method: "POST",
            headers: form_data.headers || {"Content-Type": form_data.enctype},
            body: form_data.body
          }
        }
        let response = await network.fetch(url, options, {url:source_url,top_url:source_url,referrerPolicy:source_policy,navigation:true});
        html = await response.text();
        url = response.url;
        referrer_policy = parse_referrer_policy(response.headers.get('referrer-policy'));
        document_referrer = response.request_referrer || '';
      }
      catch (e) {
        error = util.format_error(e);
      }  
    }
    if (navigation_id !== this.navigation_id) return;
    this.url = new URL(url);
    this.referrer_policy = referrer_policy;
    this.document_referrer = document_referrer;
    this.history.navigate(url, {mode: navigation.history_mode || "push"});
    
    let settings = this.site_settings.find((item) => {
      return item.hostname.test(this.url.hostname);
    }) || {};
    settings = {...this.default_settings, ...settings};
    console.log("site settings:", settings);

    await rpc.wait_on_frame(this.iframe);
    if (navigation_id !== this.navigation_id) return;
    let msg_channel = new MessageChannel();
    this.rpc_target.set_target(msg_channel.port1);
    msg_channel.port1.start();
    await rpc.set_host(this.iframe, msg_channel.port2);
    const beacon_context = network.beacons.register(this.id, {url: this.url.href, top_url: this.url.href});

    try {
      await this.send_page({
        url: this.url.href,
        html: html, 
        frame_id: this.id,
        beacon_context,
        crypto_available: crypto_service.methods,
        referrer_policy, document_referrer,
        error: error,
        settings: settings,
        default_settings: this.default_settings,
        local_storage: local_storage[this.url.origin],
        session_storage: this.session_storage[this.url.origin],
        cookies: site_data.documentCookies(this.url.href),
        history: {...this.history.snapshot(), traversed: !!navigation.traversed, restored: navigation.history_mode === "reload"},
        version: version
      });
    }
    catch (e) {
      if (navigation_id !== this.navigation_id) return;
      let error_msg = util.format_error(e);
      await this.send_page({
        url: this.url.href,
        html: html, 
        frame_id: this.id,
        beacon_context,
        crypto_available: crypto_service.methods,
        referrer_policy, document_referrer,
        error: error_msg,
        settings: settings,
        default_settings: this.default_settings,
        local_storage: undefined,
        version: version
      });
    }
    if (navigation_id !== this.navigation_id) return;
    this.iframe.style.backgroundColor = "unset";
    this.is_navigating = false;
    this.on_load();
  }
}

rpc.rpc_handlers["navigate"] = async (frame_id, url, reload=true, form_data=null, navigation={}) => {
  let frame = iframes[frame_id];
  if (!frame) return;

  if (reload) {
    await frame.navigate_to(url, form_data, {...navigation,initiated:true});
  }
  else {
    frame.url = new URL(url);
    frame.on_url_change();
  }
}

rpc.rpc_handlers["history_mutate"] = (id, kind, state, url, scroll) => {
  const frame = iframes[id];
  if (!frame?.history) throw new DOMException("Inactive history", "InvalidStateError");
  frame.history.mutate(kind, state, url, scroll);
  frame.url = new URL(url);
  frame.on_url_change();
};

rpc.rpc_handlers["history_go"] = (id, delta, scroll) => {
  const frame = iframes[id];
  if (!frame?.history) return null;
  const snapshot = frame.history.go(delta, scroll);
  if (!snapshot) return null;
  if (snapshot.sameDocument) {
    frame.url = new URL(snapshot.url);
    frame.on_url_change();
    return snapshot;
  }
  frame.navigate_to(snapshot.url, null, {history_mode: "traverse", traversed: true}).catch(console.error);
  return null;
};

rpc.rpc_handlers["local_storage"] = async (frame_id, entries) => {
  let frame = iframes[frame_id];
  if (!frame) return;
  site_data.setLocal(frame.url.origin, entries);
}

rpc.rpc_handlers["session_storage"] = async (frame_id, entries) => {
  const frame = iframes[frame_id];
  if (frame) frame.session_storage[frame.url.origin] = entries;
};

rpc.rpc_handlers["cookie_set"] = async (frame_id, value) => {
  const frame = iframes[frame_id];
  if (frame) site_data.setCookie(frame.url.href, value, false);
};

rpc.rpc_handlers["frame_register"] = (parent_id, child_id, url, options = {}) => {
  const parent = iframes[parent_id];
  if (!parent || iframes[child_id]) throw new TypeError("Invalid child frame");
  const root = iframes[parent.root_id];
  const saved = saved_child_histories.get(child_id);
  saved_child_histories.delete(child_id);
  const child = {
    id: child_id, parent_id, root_id: root.id, url: new URL(url),
    origin: options.worker ? new URL(url).protocol === "data:" ? "null" : parent.origin || parent.url.origin : new URL(url).origin,
    session_storage: parent.session_storage,
    history: saved?.history || new NavigationHistory(),
    async navigate_to(url, form_data, navigation = {}) {
      navigation = {...navigation,source_url:child.url.href};
      child.url = new URL(url, child.url);
      child.history.save_scroll(navigation.scroll);
      child.pending_navigation = navigation;
      const port = parent_id === root.id ? root.rpc_target.target : root.rpc_target.extra_frame_targets.get(parent_id);
      if (!port) throw new DOMException("Parent frame is disconnected", "InvalidStateError");
      await rpc.call_procedure(port, "child_navigate", [child_id, child.url.href, form_data, {...navigation,from_child:true}]);
    },
    on_url_change() {}
  };
  iframes[child_id] = child;
  child.history.navigate(url, {mode: saved?.navigation?.history_mode || "push"});
  return {
    beacon_context: network.beacons.register(child_id, {url: child.url.href, top_url: root.url.href}),
    crypto_available: crypto_service.methods,
    local_storage: site_data.local[child.origin],
    session_storage: child.session_storage[child.origin],
    cookies: site_data.documentCookies(child.origin === "null" ? child.url.href : child.origin + "/"),
    history: {...child.history.snapshot(), traversed: !!saved?.navigation?.traversed, restored: saved?.navigation?.history_mode === "reload"}
  };
};

rpc.rpc_handlers["frame_unregister"] = (child_id, options = {}) => {
  const child = iframes[child_id];
  if (!child?.parent_id) return;
  if (options.keep_history) saved_child_histories.set(child_id, {root_id: child.root_id, history: child.history, navigation: child.pending_navigation});
  else saved_child_histories.delete(child_id);
  for (const frame of Object.values(iframes)) {
    if (frame.parent_id === child_id) rpc.rpc_handlers["frame_unregister"](frame.id);
  }
  indexed_db.disconnect(child_id);
  network.clean_ws_connections(child_id);
  iframes[child.root_id]?.rpc_target.remove_extra_target(child_id);
  delete iframes[child_id];
};

// Page procedures travel over the established MessagePorts, never a public window listener.
