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
import {load_document_html,load_document_xml,run_document_script,initialize_blank_document,on_document_complete} from './document_input.mjs';
import {runtime_html} from '../runtime_html.mjs';
import {navigation_activation} from './user_activation.mjs';
import {configure_document_encoding} from './document_encoding.mjs';
import {configure_service_workers} from './polyfill/service_worker.mjs';
import {configure_autofocus} from './autofocus.mjs';
import {configure_filesystem} from './polyfill/filesystem.mjs';
import {create_runtime_script,append_runtime_script} from './runtime_script.mjs';

const navigate_rpc = rpc.create_rpc_wrapper(rpc.host, "navigate");
export function navigate(id, url, reload = true, form_data = null, navigation = {}) {
  return navigate_rpc(id,url,reload,form_data,{referrerPolicy:document_referrer_policy(),activation:navigation_activation(),...navigation}).then(result=>{
    if(result?.download)load_cookies(result.cookies);return result;
  });
}
export const local_storage = rpc.create_rpc_wrapper(rpc.host, "local_storage");
export const session_storage = rpc.create_rpc_wrapper(rpc.host, "session_storage");

export let runtime_src = self.document?.currentScript?.textContent;
export let worker_type;
export let worker_origin;
export let worker_probe = false;
export let service_worker = false;
export let service_worker_host = false;
export let url; //the proxied page url
export let frame_id; //the current frame id
export let beacon_context;
export let crypto_available = false;
export let referrer_policy = default_referrer_policy;
export let document_referrer = '';
export let character_encoding = 'UTF-8';
export let frame_html; //the html for the frame runtime
export let version; //the sandstone version
export let is_loaded = false;
export let pristine_blank = false;
export let ready_state = "loading";
export function set_ready_state(value){ready_state=value;}
export let base_url;
// Inline frame documents have an about: URL but inherit a frozen creator base
// and cookie URL. Their origin is distinct from Location.origin.
// Blob documents also retain their virtual creator origin in Location.origin.
export let inherited_base_url, document_origin, cookie_url, location_origin;
export let is_iframe = false;
export let automatic_features = true;
export let sandboxed_context = false;
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
        if(!sources.has(window.location.href))sources.set(window.location.href,{url:source.url,cookie_url:source.cookie_url,inherited_base_url:source.inherited_base_url,character_encoding:source.character_encoding,location_origin:source.location_origin,beacon_context:source.beacon_context});
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
  character_encoding=source.character_encoding||'UTF-8';configure_document_encoding(document,ctx.document,character_encoding);
  inherited_base_url=source.inherited_base_url;cookie_url=['about:','blob:'].includes(new URL(source.url).protocol)?source.cookie_url||source.url:undefined;base_url=inherited_base_url||source.url;
  location_origin=source.location_origin;
  network.known_urls[after]=source.url;
  set_location(source.url);opened_url?.(source.url);
  rpc.call_procedure(rpc.host,'document_open',[frame_id,beacon_context,{url:source.url,cookie_url,inherited_base_url,source_context:source.beacon_context}]).catch(()=>{});
}

export function eval_script(script_element, script_text,{run=callback=>run_document_script(script_element,callback),context}={}) {
  const previous_script=get_current_script();
  set_current_script(script_element);
  const script=create_runtime_script();
  try {
    const url=context?.url||script_element.__sandstone_url__||ctx.document.baseURI;
    let rewritten_js = parser.rewrite_js(script_text, {
      url,
      importReferrer:{url:context?.muted?'about:blank':url,credentials:context?.credentials||'same-origin',referrerPolicy:context?.referrerPolicy||document_referrer_policy()},
      sourceURL:script_element.__sandstone_url__ || ctx.location.href
    });
    script.textContent = rewritten_js;
    run(()=>append_runtime_script(script,{bodyFirst:true}));
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
  service_worker = !!options.service_worker;
  configure_filesystem();
  runtime_src = options.runtime_src;
  is_loaded = true;
}

function get_frame_html() {
  frame_html=runtime_html(runtime_src);
}

function prepare_html(options) {
  character_encoding=options.character_encoding||'UTF-8';
  referrer_policy = options.referrer_policy || default_referrer_policy;
  reset_document_referrer_policy(referrer_policy);
  document_referrer = options.document_referrer || '';
  crypto_available = options.crypto_available || false;
  configure_crypto(crypto_available);
  beacon_context = options.beacon_context;
  version = options.version;
  is_iframe = options.is_iframe || false;
  automatic_features = options.automatic_features!==false;
  sandboxed_context = !!options.sandboxed_context;
  service_worker_host = !!options.service_worker_host;
  cookie_cross_site = !!options.cookie_cross_site;
  default_settings = options.default_settings;
  site_settings = {...default_settings, ...options.settings};
  network.known_urls[location.href] = options.url;
  network.enable_network();

  set_url(options.url);
  inherited_base_url = options.inherited_base_url;
  document_origin = options.document_origin;
  location_origin = options.location_origin;
  cookie_url = options.cookie_url;
  base_url = inherited_base_url || options.url;
  set_frame_id(options.frame_id);
  if(options.window_name!==undefined)globalThis.name=options.window_name;
  get_frame_html();
  const ready=update_ctx(options);
  configure_filesystem();
  configure_document_encoding(document,ctx.document,character_encoding);
  configure_window_messages(options);
  return Promise.all([ready,configure_cookies(options.cookies,ctx.document),configure_service_workers(options)]).then(result=>{configure_autofocus();return result;});
}

export function initialize_blank(options,onload,onurl){
  const ready=prepare_html(options);is_loaded=true;initialize_blank_document();pristine_blank=true;
  opened_url=onurl;on_document_complete(onload);return ready;
}

async function load_html(options) {
  await prepare_html(options);

  if (options.error) {
    if(document.contentType!=='text/html'){
      const message=String(options.error).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
      const content='<div xmlns="http://www.w3.org/1999/xhtml" style="font:14px sans-serif;white-space:pre-wrap"><h2>An unexpected error has occurred</h2><pre>'+message+'</pre></div>';
      const markup=document.contentType==='image/svg+xml'?'<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><foreignObject width="100%" height="100%">'+content+'</foreignObject></svg>':'<html xmlns="http://www.w3.org/1999/xhtml"><body>'+content+'</body></html>';
      await load_document_xml(markup,{scriptingEnabled:false});return;
    }
    document.getElementById("loading_text").style.display = "none";
    document.getElementById("error_div").style.display = "initial";
    document.getElementById("error_msg").innerText = options.error;
    document.getElementById("version_text").innerText = `Sandstone v${version.ver} (${version.hash})`;
    return;
  }

  is_loaded = true;
  if(document.contentType==='text/html')await load_document_html(options.html,{scriptingEnabled:site_settings.allow_js});
  else await load_document_xml(options.html,{scriptingEnabled:site_settings.allow_js});
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
