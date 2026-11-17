import * as network from "../network.mjs";
import { ctx, convert_url, intercept_property, proxy_function } from "../context.mjs";
import { parse_css } from "./css.mjs";
import {parse_referrer_policy} from '../../referrer.mjs';
import {document_referrer_policy} from '../intercept/document.mjs';
import * as loader from '../loader.mjs';

export function is_style_link(element){
  return Element.prototype.matches.call(element,'[rel~="stylesheet" i], [rel~="preload" i][as="style" i]');
}

export function rewrite_stylesheet(element,initialHref) {
  element.removeAttribute("integrity");
  const initial = typeof initialHref==='function' ? initialHref() : initialHref===undefined ? element.getAttribute("href") || element.getAttribute("data-href") : initialHref;
  let remote = "";
  let generation = 0;
  let pending;
  let blob_url;
  let error_timer,error_observer;
  function clear_error(){clearTimeout(error_timer);error_observer?.disconnect();error_observer=null;}
  function failed(error,current){
    if(current!==generation)return;
    const url=remote;
    const deliver=()=>{
      if(current!==generation){clear_error();return;}
      // Initial links are rewritten in an inert document. Their error handlers
      // must see the installed page and its preceding classic scripts.
      if(!loader.is_loaded||!element.isConnected||element.ownerDocument!==document){
        error_observer??=new MutationObserver(()=>{clear_error();error_timer=setTimeout(deliver,0);});
        error_observer.observe(document,{childList:true,subtree:true});return;
      }
      clear_error();
      console.error(`Stylesheet failed: ${url}: ${error.message}`);
      element.dispatchEvent(new Event('error'));
    };
    error_timer=setTimeout(deliver,0);
  }
  const descriptor = intercept_property(element, "href", {
    get: () => remote || descriptor.get.call(element),
    set(value) {
      value=`${value}`;
      clear_error();
      const current = ++generation;
      // Clearing before the first await also protects dynamically inserted links.
      element.removeAttribute("href");
      try{remote=convert_url(value,ctx.document.baseURI);}
      catch{remote=value;return;}
      if (remote.startsWith("data:") || remote.startsWith("blob:")) {
        descriptor.set.call(element, remote);
        return;
      }
      const url = remote;
      pending = (async () => {
        const inherited_policy = document_referrer_policy();
        const response = await network.fetch(url, {
          mode:element.crossOrigin === null ? 'no-cors' : 'cors',
          credentials:element.crossOrigin === 'anonymous' ? 'same-origin' : 'include',
          referrerPolicy:element.referrerPolicy || inherited_policy
        });
        if (!response.ok) throw new TypeError(`Stylesheet request failed: ${response.status}`);
        const policy = response.headers.get('referrer-policy');
        // Chromium inherits the document policy for @import requests, while
        // image/font resources use the default unless the CSS delivers a policy.
        const request_context = {referrer: response.url || url,
          referrerPolicy: parse_referrer_policy(policy),
          importPolicy: parse_referrer_policy(policy, inherited_policy)};
        const css = await parse_css(await response.text(), response.url || url, undefined, request_context);
        if (current !== generation) return;
        if (blob_url) { URL.revokeObjectURL(blob_url); delete network.known_urls[blob_url]; delete network.stylesheet_contexts[blob_url]; }
        blob_url = network.create_blob_url(new Blob([css], {type: "text/css"}), response.url || url, request_context);
        descriptor.set.call(element, blob_url);
      })().catch(error=>failed(error,current));
    }
  });
  proxy_function(element, "setAttribute", (target, receiver, args) => {
    if (String(args[0]).toLowerCase() === "href") { element.href = args[1]; return; }
    return Reflect.apply(target, receiver, args);
  });
  if (initial) element.href = initial;
  return pending;
}
