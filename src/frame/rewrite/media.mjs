import { ctx, intercept_property, proxy_function } from "../context.mjs";
import * as network from "../network.mjs";
import { rewrite_srcset } from "../srcset.mjs";

const prepared = new WeakMap();
const source_loads = new WeakMap();

function source_pending(element) {
  const parent = element.parentElement;
  if (!(element instanceof HTMLSourceElement) || !(parent instanceof HTMLMediaElement)) return () => {};
  const state = source_loads.get(parent) || {pending: 0, revision: 0};
  source_loads.set(parent, state);
  state.pending++;
  state.revision++;
  return () => {
    state.pending--;
    const revision = ++state.revision;
    queueMicrotask(() => {
      if (!state.pending && state.revision === revision && parent.isConnected) parent.load();
    });
  };
}

export function clone_media(source,copy){
  const authored=prepared.get(source);
  if(!authored)return false;
  rewrite_media(copy,authored);
  return true;
}

export function rewrite_media(element,initial_sources) {
  if (prepared.has(element)) return;
  prepared.set(element,null);
  const get = element.getAttribute.bind(element);
  const remove = element.removeAttribute.bind(element);
  const properties = ["src", "srcset", "poster"].filter(key => key in element);
  const authored = new Map(initial_sources||properties.map(key => [key, get(key)]));
  prepared.set(element,authored);
  const states = new Map();
  // Clear every source before starting asynchronous work, including picture sources.
  for (const key of properties) remove(key);
  const base = () => ctx.document.baseURI;

  for (const key of properties) {
    const state = {generation: 0, urls: [], controller: null};
    states.set(key, state);
    const release = urls => {
      for (const url of urls) { URL.revokeObjectURL(url); delete network.known_urls[url]; }
    };
    let descriptor;
    function update(value) {
      value = String(value);
      authored.set(key, value);
      const generation = ++state.generation;
      state.controller?.abort();
      const controller = state.controller = new AbortController();
      remove(key);
      release(state.urls);
      state.urls = [];
      const urls = [];
      const resources = new Map();
      const done = key === "src" ? source_pending(element) : () => {};
      const resource = async source => {
        if (!source) return source;
        const url = new URL(source, base());
        if (["data:", "blob:"].includes(url.protocol)) return url.href;
        if (!resources.has(url.href)) resources.set(url.href, (async () => {
          const crossOrigin = element.crossOrigin ?? (element instanceof HTMLSourceElement ? element.parentElement?.crossOrigin : null);
          const response = await network.fetch(url.href, {
            signal: controller.signal, credentials: crossOrigin === "anonymous" ? "same-origin" : "include",
            mode: crossOrigin == null ? 'no-cors' : 'cors', referrerPolicy:element.referrerPolicy
          });
          if (!response.ok) throw new TypeError(`Media request failed: ${response.status}`);
          const blob = await response.blob();
          controller.signal.throwIfAborted();
          const local = network.create_blob_url(blob, url.href);
          urls.push(local);
          return local;
        })());
        return resources.get(url.href);
      };
      // Local sources retain their synchronous property behavior.
      if (key !== "srcset" && (!value || /^(data|blob):/i.test(value))) {
        descriptor.set.call(element, value);
        done();
        return;
      }
      (async () => {
        try {
          const rewritten = key === "srcset" ? await rewrite_srcset(value, async source => {
            try { return await resource(source); }
            catch (error) { if (controller.signal.aborted) throw error; return "data:application/octet-stream,"; }
          }) : await resource(value);
          if (generation !== state.generation) { release(urls); return; }
          state.urls = urls;
          descriptor.set.call(element, rewritten);
        } catch (error) {
          release(urls);
          if (generation === state.generation && !controller.signal.aborted) element.dispatchEvent(new Event("error"));
        } finally { done(); }
      })();
    }
    descriptor = intercept_property(element, key, {
      get() {
        const value = authored.get(key);
        if (value === null || value === undefined) return descriptor.get.call(element);
        if (key === "srcset") return value;
        try { return new URL(value, base()).href; } catch { return value; }
      },
      set: update
    });
    state.update = update;
    state.release = release;
  }

  if ("currentSrc" in element) {
    let current = intercept_property(element, "currentSrc", {
      get() {
        const value = current.get.call(element);
        return network.known_urls[value] || value;
      }
    });
  }
  proxy_function(element, "getAttribute", (target, receiver, args) => {
    const key = String(args[0]).toLowerCase();
    return authored.has(key) ? authored.get(key) : Reflect.apply(target, receiver, args);
  });
  proxy_function(element, "hasAttribute", (target, receiver, args) => {
    const key = String(args[0]).toLowerCase();
    return authored.has(key) ? authored.get(key) !== null : Reflect.apply(target, receiver, args);
  });
  proxy_function(element, "setAttribute", (target, receiver, args) => {
    const state = states.get(String(args[0]).toLowerCase());
    if (state) { state.update(args[1]); return; }
    return Reflect.apply(target, receiver, args);
  });
  proxy_function(element, "removeAttribute", (target, receiver, args) => {
    const key = String(args[0]).toLowerCase();
    const state = states.get(key);
    if (state) {
      authored.set(key, null);
      state.generation++;
      state.controller?.abort();
      state.release(state.urls);
      state.urls = [];
    }
    return Reflect.apply(target, receiver, args);
  });
  proxy_function(element, "toggleAttribute", (target, receiver, args) => {
    const key = String(args[0]).toLowerCase();
    if (!states.has(key)) return Reflect.apply(target, receiver, args);
    const exists = element.hasAttribute(key);
    const wanted = args.length > 1 ? Boolean(args[1]) : !exists;
    if (wanted && !exists) element.setAttribute(key, "");
    if (!wanted && exists) element.removeAttribute(key);
    return wanted;
  });
  for (const method of ["setAttributeNS", "getAttributeNS", "hasAttributeNS", "removeAttributeNS"]) {
    proxy_function(element, method, (target, receiver, args) => {
      if (args[0] === null || args[0] === "") {
        return element[method.replace("NS", "")](...args.slice(1));
      }
      return Reflect.apply(target, receiver, args);
    });
  }
  // Removing a temporary source can produce a native empty-source error.
  element.addEventListener("error", event => {
    if (!event.isTrusted) return;
    if (properties.every(key => !get(key))) event.stopImmediatePropagation();
  }, true);
  for (const [key, value] of authored) if (value !== null) states.get(key).update(value);
}
