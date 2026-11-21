import * as loader from "../loader.mjs";
import * as rpc from "../../rpc.mjs";
import { ctx } from "../context.mjs";
import {clone_value as structuredClone} from '../clone.mjs';
import { set_location } from "./location.mjs";
import { history_url } from "../../history.mjs";
import {document_states} from '../document_identity.mjs';
import {cookie_document_active} from './cookie.mjs';
import {navigation_activation} from '../user_activation.mjs';
import {listen_runtime} from '../runtime_events.mjs';

const views=document_states('history-views');
const NativeHistory=globalThis.History,native=NativeHistory&&Object.getOwnPropertyDescriptors(NativeHistory.prototype);
const physicalHistory=globalThis.history,physicalLocation=globalThis.location,replaceLocation=physicalLocation?.replace;
const stopEvent=Event.prototype.stopImmediatePropagation;
const focusWindow=globalThis.focus,query=globalThis.Document?.prototype.querySelector,hasFocus=globalThis.Document?.prototype.hasFocus;
if(NativeHistory){
  // Fragment processing below uses the browser's own document navigation. Its
  // physical history events must not escape alongside the virtual URL events.
  for(const type of ['popstate','hashchange'])listen_runtime(globalThis,type,event=>{if(event.isTrusted)Reflect.apply(stopEvent,event,[]);},true);
}
const text=value=>{if(typeof value==='symbol')throw new TypeError('Cannot convert a Symbol to a string');return String(value);};
if(NativeHistory){
  for(const name of ['pushState','replaceState','go','back','forward'])Object.defineProperty(NativeHistory.prototype,name,{...native[name],value:new Proxy(native[name].value,{apply(target,receiver,args){
    const view=views.get(receiver);return view?view.invoke(name,'value',args):Reflect.apply(target,receiver,args);
  }})});
  for(const name of ['state','length','scrollRestoration']){
    const descriptor={...native[name]};
    for(const operation of ['get','set'])if(descriptor[operation])descriptor[operation]=new Proxy(descriptor[operation],{apply(target,receiver,args){
      const view=views.get(receiver);return view?view.invoke(name,operation,args):Reflect.apply(target,receiver,args);
    }});
    Object.defineProperty(NativeHistory.prototype,name,descriptor);
  }
}
export const history_hash=(history,...args)=>views.get(history).invoke('_hash','value',args);
export const restore_history=(history,...args)=>views.get(history).invoke('_restored','value',args);
export const retarget_history=history=>views.get(history).invoke('_retarget','value',[]);

const mutate = rpc.create_rpc_wrapper(rpc.host, "history_mutate");
const traverse = rpc.create_rpc_wrapper(rpc.host, "history_go");
const scroll = () => [globalThis.scrollX || 0, globalThis.scrollY || 0];

function scroll_fragment(url) {
  // Replacing the current physical entry before navigating to the same URL
  // keeps native history bounded and avoids a second hashchange. Let the UA
  // handle :target, ancestor revealing, focus and the next Tab starting point.
  const physical=physicalLocation.href.split('#')[0]+(new URL(url).hash||'#');
  Reflect.apply(native.replaceState.value,physicalHistory,[Reflect.apply(native.state.get,physicalHistory,[]),'',physical]);
  Reflect.apply(replaceLocation,physicalLocation,[physical]);
  // A virtual top-level page still occupies a native subframe. Its viewport
  // must receive keyboard routing when a non-focusable fragment is selected.
  if(!loader.is_iframe&&query.call(document,':target')&&!hasFocus.call(document))Reflect.apply(focusWindow,globalThis,[]);
}

export class FakeHistory {
  #state;
  #length;
  #index;
  #scrollRestoration = "auto";
  #native;
  #document;
  constructor(snapshot = {}) {
    this.#state = "state" in snapshot ? structuredClone(snapshot.state) : null;
    this.#length = snapshot.length || 1;
    this.#index = snapshot.index ?? 0;
    this.#native=globalThis.history;
    this.#document=globalThis.document;
    // Native History rejects structured cloning; a plain facade would not.
    const facade=new Proxy(Object.create(NativeHistory.prototype),{}),controller=this;
    // Private fields belong to the creating realm's class. Dispatch borrowed
    // prototype calls through that realm instead of applying a foreign class.
    views.set(facade,{invoke(name,operation,args){return Reflect.apply(Object.getOwnPropertyDescriptor(FakeHistory.prototype,name)[operation],controller,args);}});
    return facade;
  }
  #validate(){
    // Inherited about:blank runtimes can retain readable native History slots
    // after removal. Use the original document liveness probe as well.
    if(!cookie_document_active(this.#document))throw new DOMException('History document is unavailable','SecurityError');
    Reflect.apply(native.state.get,this.#native,[]);
  }
  get length() { this.#validate();return this.#length; }
  get state() { this.#validate();return this.#state; }
  get scrollRestoration() { this.#validate();return this.#scrollRestoration; }
  set scrollRestoration(value) {
    value=text(value);
    if (!["auto", "manual"].includes(value))return;
    this.#validate();
    this.#scrollRestoration = value;
  }
  #mutate(kind, state, value) {
    const copy = structuredClone(state);
    const url = history_url(value, ctx.location.href, ctx.document.baseURI);
    const position = scroll();
    this.#state = copy;
    if (kind === "push") { this.#index++; this.#length = this.#index + 1; }
    set_location(url);
    mutate(loader.frame_id, kind, copy, url, position).catch(console.error);
  }
  pushState(state, unused, url) {
    if (arguments.length < 2) throw new TypeError("pushState requires state and title");
    text(unused);url=url==null?null:text(url);this.#validate();
    this.#mutate("push", state, url);
  }
  replaceState(state, unused, url) {
    if (arguments.length < 2) throw new TypeError("replaceState requires state and title");
    text(unused);url=url==null?null:text(url);this.#validate();
    this.#mutate("replace", state, url);
  }
  back() { this.go(-1); }
  forward() { this.go(1); }
  go(delta = 0) {
    delta = (+delta) >> 0;this.#validate();
    if (!delta) { ctx.location.reload(); return; }
    traverse(loader.frame_id, delta, scroll(),navigation_activation()).then(snapshot => {
      if (!snapshot) return;
      this.#state = structuredClone(snapshot.state);
      this.#index = snapshot.index;
      this.#length = snapshot.length;
      set_location(snapshot.url);
      globalThis.dispatchEvent(new PopStateEvent("popstate", {state: this.#state}));
      // Traversal needs a target-only update, including script-created entries.
      // Calling scroll_fragment here would incorrectly move keyboard focus.
      if (this.#scrollRestoration === "auto") globalThis.scrollTo(...snapshot.scroll);
      if (new URL(snapshot.oldURL).hash !== new URL(snapshot.url).hash) {
        globalThis.dispatchEvent(new HashChangeEvent("hashchange", {oldURL: snapshot.oldURL, newURL: snapshot.url}));
      }
    }).catch(console.error);
  }
  _hash(url, replace = false) {
    const oldURL = ctx.location.href;
    if (oldURL !== url) this.#mutate(replace ? "replace" : "push", null, url);
    setTimeout(() => {
      if(!cookie_document_active(this.#document))return;
      if (oldURL !== url) globalThis.dispatchEvent(new PopStateEvent("popstate", {state: this.#state}));
      scroll_fragment(url);
      if (oldURL !== url) globalThis.dispatchEvent(new HashChangeEvent("hashchange", {oldURL, newURL: url}));
    }, 0);
  }
  _restored(snapshot) {
    if (!snapshot?.traversed && !snapshot?.restored) {
      if (new URL(ctx.location.href).hash) scroll_fragment(ctx.location.href);
      return;
    }
    if (snapshot.traversed) globalThis.dispatchEvent(new PopStateEvent("popstate", {state: this.#state}));
    if (this.#scrollRestoration === "auto") globalThis.scrollTo(...snapshot.scroll);
  }
  _retarget(){this.#document=globalThis.document;this.#native=globalThis.history;}
  get [Symbol.toStringTag]() { return "History"; }
}
