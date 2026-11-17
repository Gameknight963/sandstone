import * as rewrite from "./index.mjs";

import { parse_css } from "./css.mjs";
import { ctx, get_dom_property } from "../context.mjs";
import {rewrite_event_attributes} from '../event_attributes.mjs';

const rewritten_elements = new WeakSet();

//non-recursive element rewrite
function rewrite_element_single(element) {
  const tag = get_dom_property(element, "tagName");
  //handlers for specific tags
  let promise;
  if (tag === "NOSCRIPT")
    promise = rewrite.noscript(element);
  else if (Element.prototype.matches.call(element, "img, source, video, audio, input[type='image'], track"))
    promise = rewrite.media(element);
  else if (element instanceof HTMLLinkElement)
    promise = Element.prototype.matches.call(element,'[rel~="stylesheet" i]') ? rewrite.stylesheet(element) : rewrite.link(element);
  else if (element instanceof HTMLMetaElement)
    promise = rewrite.meta(element);
  else if (element instanceof HTMLStyleElement)
    promise = rewrite.style(element);
  else if (element instanceof HTMLScriptElement)
    promise = rewrite.script(element);
  else if (element instanceof HTMLIFrameElement)
    promise = rewrite.iframe(element);
  let promises = [promise];

  rewrite_event_attributes(element);

  //rewrite inline styles
  let inline_style = Element.prototype.getAttribute.call(element, "style");
  if (inline_style) {
    const style = get_dom_property(element, "style");
    style.cssText = "";
    let new_css = parse_css(inline_style, ctx.document.baseURI)
    if (typeof new_css === "string") {
      style.cssText = new_css;
    }
    else {
      promises.push((async () => {
        style.cssText = await new_css;
      })());
    }
  }

  EventTarget.prototype.addEventListener.call(element, "focus", () => {
    ctx.document.activeElement = element;
  })

  return promises;
}

//a recursive wrapper for rewriting an element and its descendants
export function rewrite_element(element) {
  if (element instanceof DocumentFragment || element instanceof Document) {
    return Promise.all([...get_dom_property(element, "children")].map(child => rewrite_element(child)));
  }
  if (!(element instanceof Element))
    return;

  let promises = [];
  if (!rewritten_elements.has(element) && (element instanceof HTMLFormElement || element.__rewritten__ !== true)) {
    rewritten_elements.add(element);
    promises = rewrite_element_single(element);
  }
  
  //recursively rewrite children
  let children = [...get_dom_property(element, "children")];
  for (let child of children) {
    promises.push(rewrite_element(child));
  }

  //if nothing returned a promise - then return synchronously
  promises = promises.filter((promise) => promise);
  if (!promises.length)
    return undefined;
  //otherwise we can let the caller wait for all promises to resolve
  return Promise.all(promises);
}
