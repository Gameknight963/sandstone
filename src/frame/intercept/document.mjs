import { ctx, get_handler_keys } from "../context.mjs";
import { create_obj_proxy } from '../global_functions.mjs';
import { get_cookie, set_cookie } from "../polyfill/cookie.mjs";
import * as loader from "../loader.mjs";
import { rewrite_media } from "../rewrite/media.mjs";
import {parse_referrer_policy} from '../../referrer.mjs';
import {configure_document_base,document_base_url} from '../document_base.mjs';
import {is_svg_resource,rewrite_svg_resource} from '../svg_resources.mjs';
import * as ranges from './ranges.mjs';
import {input_ready_state} from '../document_input.mjs';

configure_document_base(()=>ctx.location?.href||loader.url,()=>loader.is_loaded?undefined:loader.base_url);

if(globalThis.document){
  const view=Object.getOwnPropertyDescriptor(Document.prototype,'defaultView');
  Object.defineProperty(Document.prototype,'defaultView',{...view,get(){
    const native=view.get.call(this);
    return this===globalThis.document?ctx.window:native;
  }});
}

function prepare_media(element) {
  if (Element.prototype.matches.call(element,"img, source, video, audio, input, track")) rewrite_media(element);
  if(is_svg_resource(element))rewrite_svg_resource(element);
  return element;
}

if(globalThis.document){
  const view=Object.getOwnPropertyDescriptor(Document.prototype,'defaultView').get;
  for(const key of ['createElement','createElementNS']){
    const original=Document.prototype[key];
    Document.prototype[key]=new Proxy(original,{apply(target,receiver,args){
      const element=Reflect.apply(target,receiver,args);
      // Frameworks also create nodes through an element's native ownerDocument.
      // Inert parser/mirror documents must retain their inactive behavior.
      return view.call(receiver)?prepare_media(element):element;
    }});
  }
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
  currentScript: null
}
const script_root=globalThis.Node?.prototype.getRootNode;

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
  get createRange(){return Object.hasOwn(internal,'createRange')?internal.createRange:ranges.createRange;}
  set createRange(value){internal.createRange=value;}
  get getSelection(){return Object.hasOwn(internal,'getSelection')?internal.getSelection:ranges.getSelection;}
  set getSelection(value){internal.getSelection=value;}
  get location() {return ctx.location}
  get URL() {return ctx.location.href}
  get baseURI() {
    return document_base_url();
  }
  get readyState() {return input_ready_state()||loader.ready_state}
  get documentURI() {return ctx.location.href}
  get referrer() {return loader.document_referrer}
  get currentScript() {return internal.currentScript&&script_root.call(internal.currentScript) instanceof ShadowRoot?null:internal.currentScript}
  set currentScript(value) {internal.currentScript = value}
  get activeElement() {return this.__target__.activeElement}

  createElement(tag_name, options) {
    return prepare_media(this.__target__.createElement(tag_name, options));
  }

  createElementNS(namespace, qualified_name, options) {
    return prepare_media(this.__target__.createElementNS(namespace, qualified_name, options));
  }

}

export const custom_document = new CustomDocument();
