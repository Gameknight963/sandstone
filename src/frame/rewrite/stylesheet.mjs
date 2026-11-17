import * as network from "../network.mjs";
import { ctx, convert_url, intercept_property, proxy_function } from "../context.mjs";
import { parse_css } from "./css.mjs";

export function rewrite_stylesheet(element) {
  element.removeAttribute("integrity");
  const initial = element.getAttribute("href") || element.getAttribute("data-href");
  let remote = "";
  let generation = 0;
  let pending;
  let blob_url;
  const descriptor = intercept_property(element, "href", {
    get: () => remote || descriptor.get.call(element),
    set(value) {
      const current = ++generation;
      remote = convert_url(value, ctx.document.baseURI);
      // Clearing before the first await also protects dynamically inserted links.
      element.removeAttribute("href");
      if (remote.startsWith("data:") || remote.startsWith("blob:")) {
        descriptor.set.call(element, remote);
        return;
      }
      const url = remote;
      pending = (async () => {
        const response = await network.fetch(url, {
          mode:element.crossOrigin === null ? 'no-cors' : 'cors',
          credentials:element.crossOrigin === 'anonymous' ? 'same-origin' : 'include',
          referrerPolicy:element.referrerPolicy
        });
        if (!response.ok) throw new TypeError(`Stylesheet request failed: ${response.status}`);
        const css = await parse_css(await response.text(), response.url || url);
        if (current !== generation) return;
        if (blob_url) { URL.revokeObjectURL(blob_url); delete network.known_urls[blob_url]; }
        blob_url = network.create_blob_url(new Blob([css], {type: "text/css"}), response.url || url);
        descriptor.set.call(element, blob_url);
      })().catch(error => {
        if (current === generation) element.dispatchEvent(new Event("error"));
        console.error(error);
      });
    }
  });
  proxy_function(element, "setAttribute", (target, receiver, args) => {
    if (String(args[0]).toLowerCase() === "href") { element.href = args[1]; return; }
    return Reflect.apply(target, receiver, args);
  });
  if (initial) element.href = initial;
  return pending;
}
