import * as rewrite from "./index.mjs";

import { parse_css } from "./css.mjs";
import { ctx, get_dom_property } from "../context.mjs";
import {rewrite_event_attributes} from '../event_attributes.mjs';
import {is_style_link} from './stylesheet.mjs';
import {is_svg_resource,rewrite_svg_resource} from '../svg_resources.mjs';
import {observe_media_container} from './media.mjs';
import {inline_style_version,remember_inline_style} from '../style_sources.mjs';
import {shadow_root} from '../shadow_roots.mjs';
import {note_autofocus} from '../autofocus.mjs';

const rewritten_elements = new WeakSet();

//non-recursive element rewrite
function rewrite_element_single(element) {
  observe_media_container(element);
  const tag = get_dom_property(element, "tagName");
  //handlers for specific tags
  let promise;
  if (tag === "NOSCRIPT")
    promise = rewrite.noscript(element);
  else if (Element.prototype.matches.call(element, "img, source, video, audio, input[type='image'], track"))
    promise = rewrite.media(element);
  else if(is_svg_resource(element))promise=rewrite_svg_resource(element);
  else if (element instanceof HTMLLinkElement)
    // A style preload must receive rewritten CSS before its load handler can
    // promote it to a stylesheet, including through relList or setAttribute.
    promise = is_style_link(element) ? rewrite.stylesheet(element) : rewrite.link(element);
  else if (element instanceof HTMLMetaElement)
    promise = rewrite.meta(element);
  else if (element instanceof HTMLStyleElement || globalThis.SVGStyleElement && element instanceof SVGStyleElement)
    promise = rewrite.style(element);
  else if (element instanceof HTMLScriptElement||globalThis.SVGScriptElement&&element instanceof SVGScriptElement)
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
    remember_inline_style(element,inline_style);
    const version=inline_style_version(element);
    let new_css = parse_css(inline_style, ctx.document.baseURI,undefined,{encoding:'UTF-8'})
    if (typeof new_css === "string") {
      style.cssText = new_css;
      remember_inline_style(element,inline_style,new_css);
    }
    else {
      promises.push((async () => {
        const css=await new_css;
        if(inline_style_version(element)!==version)return;
        style.cssText = css;
        remember_inline_style(element,inline_style,css);
      })());
    }
  }

  return promises;
}

//a recursive wrapper for rewriting an element and its descendants
export function rewrite_element(element) {
  if (element instanceof DocumentFragment || element instanceof Document) {
    return Promise.all([...get_dom_property(element, "children")].map(child => rewrite_element(child)));
  }
  if (!(element instanceof Element))
    return;
  note_autofocus(element);

  let promises = [];
  if (!rewritten_elements.has(element) && (element instanceof HTMLFormElement || element.__rewritten__ !== true)) {
    rewritten_elements.add(element);
    promises = rewrite_element_single(element);
  }
  
  //recursively rewrite children
  const root=shadow_root(element);
  if(root)promises.push(rewrite_element(root));
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
