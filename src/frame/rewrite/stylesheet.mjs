import * as network from "../network.mjs";
import { ctx, convert_url, intercept_property, proxy_function } from "../context.mjs";
import { parse_css } from "./css.mjs";
import {parse_referrer_policy} from '../../referrer.mjs';
import {document_referrer_policy} from '../intercept/document.mjs';
import {schedule_resource_event} from '../resource_events.mjs';
import {resource_attribute} from '../resource_attributes.mjs';
import {track_style_request} from '../style_requests.mjs';

export function is_style_link(element){
  return Element.prototype.matches.call(element,'[rel~="stylesheet" i], [rel~="preload" i][as="style" i]');
}

export function rewrite_stylesheet(element,initialHref) {
  element.removeAttribute("integrity");
  const initial = typeof initialHref==='function' ? initialHref() : initialHref===undefined ? element.getAttribute("href") ?? element.getAttribute("data-href") : initialHref;
  const remove=element.removeAttribute;
  let authored=initial??null;
  resource_attribute(element,'href',()=>authored);
  let remote = "";
  let generation = 0;
  let pending;
  let blob_url;
  let cancel_error;
  function clear_error(){cancel_error?.();cancel_error=undefined;}
  function failed(error,current){
    if(current!==generation)return;
    const url=remote;
    cancel_error=schedule_resource_event(element,()=>{
      if(current!==generation)return;
      clear_error();
      console.error(`Stylesheet failed: ${url}: ${error.message}`);
      element.dispatchEvent(new Event('error'));
    });
  }
  const descriptor = intercept_property(element, "href", {
    get() {
      if(authored===null)return '';
      try{return convert_url(authored,ctx.document.baseURI);}
      catch{return authored;}
    },
    set(value) {
      value=`${value}`;
      authored=value;
      // Clearing before the first await also protects dynamically inserted links.
      remove.call(element,"href");
      // Removing/invalidating href does not cancel an already pending native
      // stylesheet request. Only a new valid URL supersedes that request.
      if(value==='')return;
      let url;
      try{url=convert_url(value,ctx.document.baseURI);}
      catch{return;}
      clear_error();
      const current=++generation;
      remote=url;
      if (remote.startsWith("data:") || remote.startsWith("blob:")) {
        descriptor.set.call(element, remote);
        return;
      }
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
      track_style_request(element,pending);
    }
  });
  for(const name of ['getAttribute','hasAttribute','setAttribute','removeAttribute']){
    proxy_function(element,name,(target,receiver,args)=>{
      const required=name==='setAttribute'?2:1;
      if(receiver!==element||args.length<required)return Reflect.apply(target,receiver,args);
      const attribute=`${args[0]}`;
      if(attribute.toLowerCase()==='href'){
        if(name==='getAttribute')return authored;
        if(name==='hasAttribute')return authored!==null;
        if(name==='setAttribute'){element.href=args[1];return;}
        authored=null;
      }
      return Reflect.apply(target,receiver,[attribute,...args.slice(1)]);
    });
  }
  if(initial!==null&&initial!==undefined)element.href=initial;
  return pending;
}
