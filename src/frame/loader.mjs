import * as rpc from "../rpc.mjs";
import * as network from "./network.mjs";
import * as parser from "./parser.mjs";

import { update_ctx, run_script, ctx } from "./context.mjs";
import { load_cookies } from "./polyfill/cookie.mjs";
import {configure_crypto} from './polyfill/crypto.mjs';
import {default_referrer_policy} from '../referrer.mjs';
import {document_referrer_policy,reset_document_referrer_policy} from './intercept/document.mjs';
import {configure_window_messages} from './window_messages.mjs';
import {load_document_html,run_document_script} from './document_input.mjs';

const navigate_rpc = rpc.create_rpc_wrapper(rpc.host, "navigate");
export function navigate(id, url, reload = true, form_data = null, navigation = {}) {
  return navigate_rpc(id,url,reload,form_data,{referrerPolicy:document_referrer_policy(),...navigation}).then(result=>{
    if(result?.download)load_cookies(result.cookies);return result;
  });
}
export const local_storage = rpc.create_rpc_wrapper(rpc.host, "local_storage");
export const session_storage = rpc.create_rpc_wrapper(rpc.host, "session_storage");

export let runtime_src = self.document?.currentScript?.innerHTML;
export let worker_type;
export let worker_origin;
export let worker_probe = false;
export let url; //the proxied page url
export let frame_id; //the current frame id
export let beacon_context;
export let crypto_available = false;
export let referrer_policy = default_referrer_policy;
export let document_referrer = '';
export let frame_html; //the html for the frame runtime
export let version; //the sandstone version
export let is_loaded = false;
export let ready_state = "loading";
export function set_ready_state(value){ready_state=value;}
export let base_url;
export let is_iframe = false;
export let cookie_cross_site = false;
export let site_settings = {};
export let default_settings = {};
export const child_navigators = new Map();
export const child_names = new Map();
rpc.rpc_handlers["child_navigate"] = (id, url, form_data, navigation) => child_navigators.get(id)?.(url, form_data, navigation);
rpc.rpc_handlers.child_window_name=(id,value)=>child_names.get(id)?.(value);

export function eval_script(script_element, script_text,{run=callback=>run_document_script(script_element,callback)}={}) {
  const previous_script=ctx.document.currentScript;
  ctx.document.currentScript = script_element;
  let script = document.createElement("script");
  script.__rewritten__ = true;
  try {
    let rewritten_js = parser.rewrite_js(script_text, {
      url: script_element.__sandstone_url__ || ctx.document.baseURI,
      sourceURL:script_element.__sandstone_url__ || ctx.location.href
    });
    script.innerHTML = rewritten_js;
    run(()=>(document.body||document.head||document.documentElement).append(script));
  }
  catch (e) {
    console.error(e);
  }
  script.remove();
  ctx.document.currentScript = previous_script;
  script_element.dispatchEvent(new Event("load"));
}

export function set_frame_id(id) {
  frame_id = id;
}
export function set_url(_url) {
  url = _url;
}

export function set_worker_context(options) {
  beacon_context = options.beacon_context;
  referrer_policy = options.referrer_policy || default_referrer_policy;
  reset_document_referrer_policy(referrer_policy);
  crypto_available = options.crypto_available || false;
  if (!options.probe) configure_crypto(crypto_available);
  url = options.url;
  base_url = options.url;
  frame_id = options.frame_id;
  worker_type = options.type;
  worker_origin = options.origin;
  worker_probe = !!options.probe;
  runtime_src = options.runtime_src;
  is_loaded = true;
}

function get_frame_html() {
  let html = document.documentElement.outerHTML;
  let doctype = new XMLSerializer().serializeToString(document.doctype);
  frame_html = doctype + html;
}

async function load_html(options) {
  referrer_policy = options.referrer_policy || default_referrer_policy;
  reset_document_referrer_policy(referrer_policy);
  document_referrer = options.document_referrer || '';
  crypto_available = options.crypto_available || false;
  configure_crypto(crypto_available);
  beacon_context = options.beacon_context;
  version = options.version;
  is_iframe = options.is_iframe || false;
  cookie_cross_site = !!options.cookie_cross_site;
  default_settings = options.default_settings;
  site_settings = {...default_settings, ...options.settings};
  network.known_urls[location.href] = options.url;
  network.enable_network();

  set_url(options.url);
  base_url = options.url;
  set_frame_id(options.frame_id);
  if(options.window_name!==undefined)globalThis.name=options.window_name;
  get_frame_html();
  await update_ctx(options);
  configure_window_messages(options);
  load_cookies(options.cookies);

  if (options.error) {
    document.getElementById("loading_text").style.display = "none";
    document.getElementById("error_div").style.display = "initial";
    document.getElementById("error_msg").innerText = options.error;
    document.getElementById("version_text").innerText = `Sandstone v${version.ver} (${version.hash})`;
    return;
  }

  is_loaded = true;
  await load_document_html(options.html,{scriptingEnabled:site_settings.allow_js});
  ctx.history._restored(options.history);
}

async function get_favicon() {
  var favicon_url = "/favicon.ico";
  var link_elements = document.getElementsByTagName("link");
  for (var i = 0; i < link_elements.length; i++) {
    let link = link_elements[i];
    if (link.getAttribute("rel") === "icon") 
      favicon_url = link.getAttribute("href");
    if (link.getAttribute("rel") === "shortcut icon") 
      favicon_url = link.getAttribute("href");
  }

  let full_url = new URL(favicon_url, ctx.location.href);
  return full_url.href;
}

function external_eval(js) {
  return run_script(js);
}

rpc.rpc_handlers["html"] = load_html;
rpc.rpc_handlers["favicon"] = get_favicon;
rpc.rpc_handlers["eval"] = external_eval;
