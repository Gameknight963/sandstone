import { ctx, get_handler_keys, intercept_property, proxy_function } from "../context.mjs";
import { create_obj_proxy } from '../global_functions.mjs';
import { get_cookie, set_cookie } from "../polyfill/cookie.mjs";
import * as loader from "../loader.mjs";
import { rewrite_media } from "../rewrite/media.mjs";
import {parse_referrer_policy} from '../../referrer.mjs';
import {configure_document_base,document_base_url} from '../document_base.mjs';

configure_document_base(()=>ctx.location?.href||loader.url,()=>loader.is_loaded?undefined:loader.base_url);

function prepare_media(element) {
  if (element.matches("img, source, video, audio, input, track")) rewrite_media(element);
  return element;
}

let active_referrer_policy, seen_referrer_meta = new WeakMap();
export function reset_document_referrer_policy(policy) {
  active_referrer_policy = policy;
  seen_referrer_meta = new WeakMap();
}
export function document_referrer_policy(root = globalThis.document) {
  if (!active_referrer_policy) active_referrer_policy = loader.referrer_policy;
  for (const meta of root?.querySelectorAll('meta[name]') || []) {
    const name = meta.name.toLowerCase(), value = meta.content.trim().toLowerCase(), signature = name+'\0'+value;
    if (seen_referrer_meta.get(meta) === signature) continue;
    seen_referrer_meta.set(meta,signature);
    if (name !== 'referrer') continue;
    const mapped = ({never:'no-referrer',always:'unsafe-url',default:'strict-origin-when-cross-origin'})[value] || value;
    if (parse_referrer_policy(mapped) === mapped) active_referrer_policy = mapped;
  }
  // Removing a meta element or setting an invalid policy does not restore the
  // old policy in a native document. Retain the last valid delivered policy.
  return active_referrer_policy;
}

const internal = {
  currentScript: null,
  activeElement: null
}

class CustomDocument {
  constructor() {
    let keys = get_handler_keys(this);
    if (globalThis.document) {
      this.__proxy__ = create_obj_proxy(this, keys, globalThis.document);
      this.__target__ = globalThis.document;
    }   
  }

  get cookie() {return get_cookie()}
  set cookie(value) {set_cookie(value)}
  get body() {return this.__target__.body}
  get location() {return ctx.location}
  get URL() {return ctx.location.href}
  get baseURI() {
    return document_base_url();
  }
  get readyState() {return loader.ready_state}
  get documentURI() {return ctx.location.href}
  get referrer() {return loader.document_referrer}
  get currentScript() {return internal.currentScript}
  set currentScript(value) {internal.currentScript = value}
  get activeElement() {return internal.activeElement || document.body}
  set activeElement(value) {internal.activeElement = value;}

  createElement(tag_name, options) {
    return prepare_media(this.__target__.createElement(tag_name, options));
  }

  createElementNS(namespace, qualified_name, options) {
    return prepare_media(this.__target__.createElementNS(namespace, qualified_name, options));
  }

  createTreeWalker(root, whatToShow, filter) {
    const native_document = this.__target__;
    const proxy = this.__proxy__;
    if (root === this || root === proxy) root = native_document;
    const walker = native_document.createTreeWalker(root, whatToShow, filter);
    const wrap = value => value === native_document ? proxy : value;
    const unwrap = value => value === proxy ? native_document : value;
    let current;
    current = intercept_property(walker, "currentNode", {
      get: () => wrap(current.get.call(walker)),
      set: value => current.set.call(walker, unwrap(value))
    });
    let root_descriptor;
    root_descriptor = intercept_property(walker, "root", {get: () => wrap(root_descriptor.get.call(walker))});
    for (const method of ["parentNode", "firstChild", "lastChild", "previousSibling", "nextSibling", "previousNode", "nextNode"]) {
      proxy_function(walker, method, (target, receiver, args) => wrap(Reflect.apply(target, walker, args)));
    }
    return walker;
  }
}

export const custom_document = new CustomDocument();
