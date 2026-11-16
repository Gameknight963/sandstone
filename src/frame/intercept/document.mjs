import { ctx, get_handler_keys, create_obj_proxy, intercept_property, proxy_function } from "../context.mjs";
import { get_cookie, set_cookie } from "../polyfill/cookie.mjs";
import * as loader from "../loader.mjs";

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
    const href = this.__target__.querySelector("base[href]")?.getAttribute("href");
    if (href !== undefined && href !== null) {
      try { return new URL(href, ctx.location.href).href; } catch {}
    }
    return loader.is_loaded ? ctx.location.href : loader.base_url || ctx.location.href;
  }
  get readyState() {return loader.ready_state}
  get documentURI() {return ctx.location.href}
  get currentScript() {return internal.currentScript}
  set currentScript(value) {internal.currentScript = value}
  get activeElement() {return internal.activeElement || document.body}
  set activeElement(value) {internal.activeElement = value;}

  createElement(tag_name, options) {
    return this.__target__.createElement(tag_name, options);
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
