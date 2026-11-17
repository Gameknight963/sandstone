import * as rpc from "../rpc.mjs";
import * as rewrite from "./rewrite/index.mjs";
import * as network from "./network.mjs";
import * as parser from "./parser.mjs";

import { update_ctx, run_script, ctx } from "./context.mjs";
import { pending_scripts } from "./rewrite/script.mjs";
import { load_cookies } from "./polyfill/cookie.mjs";
import {resolve_base_href} from '../base_url.mjs';
import { flush_import_map } from "./polyfill/module.mjs";
import {configure_crypto} from './polyfill/crypto.mjs';
import {default_referrer_policy} from '../referrer.mjs';
import {document_referrer_policy,reset_document_referrer_policy} from './intercept/document.mjs';
import {configure_window_messages} from './window_messages.mjs';
import {scripting_html} from './scripting_html.mjs';
import {defer_declarative_roots} from './declarative_html.mjs';

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
export let base_url;
export let is_iframe = false;
export let cookie_cross_site = false;
export let site_settings = {};
export let default_settings = {};
export const child_navigators = new Map();
export const child_names = new Map();
rpc.rpc_handlers["child_navigate"] = (id, url, form_data, navigation) => child_navigators.get(id)?.(url, form_data, navigation);
rpc.rpc_handlers.child_window_name=(id,value)=>child_names.get(id)?.(value);

export function eval_script(script_element, script_text) {
  ctx.document.currentScript = script_element;
  let script = document.createElement("script");
  script.__rewritten__ = true;
  try {
    let rewritten_js = parser.rewrite_js(script_text, {
      url: script_element.__sandstone_url__ || ctx.document.baseURI,
      sourceURL:script_element.__sandstone_url__ || ctx.location.href
    });
    script.innerHTML = rewritten_js;
    document.body.append(script);
  }
  catch (e) {
    console.error(e);
  }
  script.remove();
  ctx.document.currentScript = null;
  script_element.dispatchEvent(new Event("load"));
}

async function evaluate_scripts(order) {
  let deferred = [];
  const initial = pending_scripts.splice(0).sort((a, b) => (order.get(a[1])??Infinity)-(order.get(b[1])??Infinity)||a[0]-b[0]);
  for (let [num, script_element] of initial) {
    // Scripts parsed in template contents carry a native force-async flag.
    // Initial shadow declarations instead follow normal parser script rules.
    const asynchronous=order.has(script_element)?script_element.hasAttribute('async'):script_element.async;
    if (script_element.__sandstone_module__ || script_element.hasAttribute('src')&&(script_element.defer || asynchronous)) {
      deferred.push(script_element)
    }
    else {
      script_element.__sandstone_execute__();
    }
  }
  pending_scripts.length = 0;
  ready_state = "interactive";
  ctx.document.dispatchEvent(new Event("readystatechange"));

  for (let script_element of deferred) {
    await script_element.__sandstone_execute__();
  }
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

  let parser = new DOMParser();
  const declarations=defer_declarative_roots(null,options.html,true,site_settings.allow_js);
  const source=site_settings.allow_js?scripting_html(null,declarations.value,true):{value:declarations.value,restore(){}};
  let html = parser.parseFromString(source.value, "text/html");
  source.restore(html);
  // Hydrating declarations moves scripts out of their original tree position.
  // Retain parser order before closed roots and ordinary templates are restored.
  const script_order=new WeakMap(),nodes=[html];let script_index=0;
  while(nodes.length){
    const node=nodes.pop();if(node instanceof HTMLScriptElement)script_order.set(node,script_index++);
    const children=node instanceof HTMLTemplateElement?node.content.childNodes:node.childNodes;
    for(let index=children.length-1;index>=0;index--)nodes.push(children[index]);
  }
  declarations.restore(html);
  document_referrer_policy(html);
  const base_href = [...html.querySelectorAll('base[href]')].find(node=>node instanceof HTMLBaseElement)?.getAttribute('href');
  base_url=resolve_base_href(base_href,options.url);
  
  //rewrite all html elements
  await rewrite.element(html.documentElement);

  //parse elements with ids and add them to the scope
  let id_elements = html.querySelectorAll("*[id]");
  let ctx_proto = Object.getPrototypeOf(ctx);
  for (let i = 0; i < id_elements.length; i++) {
    let element = id_elements[i];
    if (ctx_proto.hasOwnProperty(element.id)) continue;
    ctx[element.id] = element;
  }

  //apply the rewritten html
  console.log("done downloading page");
  document.documentElement.replaceWith(html.documentElement);
  flush_import_map();
  is_loaded = true;
  if (site_settings.allow_js) {
    await evaluate_scripts(script_order);
  }

  //trigger load events
  is_loaded = true;
  ctx.document.dispatchEvent(new Event("DOMContentLoaded", {bubbles: true}));
  await Promise.resolve();
  ready_state = "complete";
  ctx.document.dispatchEvent(new Event("readystatechange"));
  ctx.document.dispatchEvent(new Event("load"));
  ctx.window.dispatchEvent(new Event("load"));
  ctx.window.dispatchEvent(new PageTransitionEvent("pageshow", {persisted: false}));
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
