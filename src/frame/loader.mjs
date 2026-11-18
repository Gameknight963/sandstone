import * as rpc from "../rpc.mjs";
import * as network from "./network.mjs";
import * as parser from "./parser.mjs";

import { update_ctx, run_script, ctx } from "./context.mjs";
import { load_cookies,configure_cookies } from "./polyfill/cookie.mjs";
import {configure_crypto} from './polyfill/crypto.mjs';
import {set_location} from './polyfill/location.mjs';
import {restore_history} from './polyfill/history.mjs';
import {default_referrer_policy} from '../referrer.mjs';
import {document_referrer_policy,reset_document_referrer_policy,set_current_script,get_current_script} from './intercept/document.mjs';
import {configure_window_messages} from './window_messages.mjs';
import {load_document_html,run_document_script,initialize_blank_document,on_document_complete} from './document_input.mjs';

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
export let pristine_blank = false;
export let ready_state = "loading";
export function set_ready_state(value){ready_state=value;}
export let base_url;
// Inline frame documents have an about: URL but inherit a frozen creator base
// and cookie URL. Their origin is distinct from Location.origin.
export let inherited_base_url, document_origin, cookie_url;
export let is_iframe = false;
export let cookie_cross_site = false;
export let site_settings = {};
export let default_settings = {};
export const child_navigators = new Map();
export const child_names = new Map();
export const child_urls = new Map();
rpc.rpc_handlers["child_navigate"] = (id, url, form_data, navigation) => child_navigators.get(id)?.(url, form_data, navigation);
rpc.rpc_handlers.child_window_name=(id,value)=>child_names.get(id)?.(value);
rpc.rpc_handlers.child_url=(id,value,token)=>child_urls.get(id)?.(value,token);
let opened_url;
export function document_sources(){
  let root=globalThis;
  try{while(root.parent!==root){root.parent.document;root=root.parent;}}catch{}
  const sources=new Map(),seen=new Set(),visit=window=>{
    if(seen.has(window))return;seen.add(window);
    try{
      if(window!==globalThis&&window.sandstone_frame?.context.ctx.origin===ctx.origin){
        const source=window.sandstone_frame.loader;
        if(!sources.has(window.location.href))sources.set(window.location.href,{url:source.url,cookie_url:source.cookie_url,inherited_base_url:source.inherited_base_url});
      }
      for(let index=0;index<window.length;index++)visit(window[index]);
    }catch{}
  };
  visit(root);return sources;
}
export function document_opened(before,after,sources){
  pristine_blank=false;
  if(before===after){opened_url?.(ctx.location.href);return;}
  const source=sources.get(after);if(!source){opened_url?.(ctx.location.href);return;}
  document_origin=ctx.origin;
  inherited_base_url=source.inherited_base_url;cookie_url=new URL(source.url).protocol==='about:'?source.cookie_url||source.url:undefined;base_url=inherited_base_url||source.url;
  network.known_urls[after]=source.url;
  set_location(source.url);opened_url?.(source.url);
  rpc.call_procedure(rpc.host,'document_open',[frame_id,beacon_context,{url:source.url,cookie_url,inherited_base_url}]).catch(()=>{});
}

export function eval_script(script_element, script_text,{run=callback=>run_document_script(script_element,callback),context}={}) {
  const previous_script=get_current_script();
  set_current_script(script_element);
  let script = document.createElement("script");
  script.__rewritten__ = true;
  try {
    const url=context?.url||script_element.__sandstone_url__||ctx.document.baseURI;
    let rewritten_js = parser.rewrite_js(script_text, {
      url,
      importReferrer:{url:context?.muted?'about:blank':url,credentials:context?.credentials||'same-origin',referrerPolicy:context?.referrerPolicy||document_referrer_policy()},
      sourceURL:script_element.__sandstone_url__ || ctx.location.href
    });
    script.innerHTML = rewritten_js;
    run(()=>(document.body||document.head||document.documentElement).append(script));
  }
  catch (e) {
    console.error(e);
  }
  script.remove();
  set_current_script(previous_script);
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

function prepare_html(options) {
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
  inherited_base_url = options.inherited_base_url;
  document_origin = options.document_origin;
  cookie_url = options.cookie_url;
  base_url = inherited_base_url || options.url;
  set_frame_id(options.frame_id);
  if(options.window_name!==undefined)globalThis.name=options.window_name;
  get_frame_html();
  const ready=update_ctx(options);
  configure_window_messages(options);
  return Promise.all([ready,configure_cookies(options.cookies,ctx.document)]);
}

export function initialize_blank(options,onload,onurl){
  const ready=prepare_html(options);is_loaded=true;initialize_blank_document();pristine_blank=true;
  opened_url=onurl;on_document_complete(onload);return ready;
}

async function load_html(options) {
  await prepare_html(options);

  if (options.error) {
    document.getElementById("loading_text").style.display = "none";
    document.getElementById("error_div").style.display = "initial";
    document.getElementById("error_msg").innerText = options.error;
    document.getElementById("version_text").innerText = `Sandstone v${version.ver} (${version.hash})`;
    return;
  }

  is_loaded = true;
  await load_document_html(options.html,{scriptingEnabled:site_settings.allow_js});
  restore_history(ctx.history,options.history);
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
