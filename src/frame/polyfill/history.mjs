import * as loader from "../loader.mjs";
import * as rpc from "../../rpc.mjs";
import { ctx } from "../context.mjs";
import { set_location } from "./location.mjs";
import { history_url } from "../../history.mjs";

const mutate = rpc.create_rpc_wrapper(rpc.host, "history_mutate");
const traverse = rpc.create_rpc_wrapper(rpc.host, "history_go");
const scroll = () => [globalThis.scrollX || 0, globalThis.scrollY || 0];

function scroll_fragment(url) {
  const hash = new URL(url).hash.slice(1);
  let name = hash;
  try { name = decodeURIComponent(hash); } catch {}
  const target = document.getElementById(name) || document.getElementsByName(name)[0];
  if (target) target.scrollIntoView();
  else if (!hash || hash.toLowerCase() === "top") globalThis.scrollTo(0, 0);
}

export class FakeHistory {
  #state;
  #length;
  #index;
  #scrollRestoration = "auto";
  constructor(snapshot = {}) {
    this.#state = "state" in snapshot ? structuredClone(snapshot.state) : null;
    this.#length = snapshot.length || 1;
    this.#index = snapshot.index ?? 0;
  }
  get length() { return this.#length; }
  get state() { return this.#state; }
  get scrollRestoration() { return this.#scrollRestoration; }
  set scrollRestoration(value) {
    if (!["auto", "manual"].includes(value)) throw new TypeError("Invalid scroll restoration mode");
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
    this.#mutate("push", state, url);
  }
  replaceState(state, unused, url) {
    if (arguments.length < 2) throw new TypeError("replaceState requires state and title");
    this.#mutate("replace", state, url);
  }
  back() { this.go(-1); }
  forward() { this.go(1); }
  go(delta = 0) {
    delta = Number(delta) >> 0;
    if (!delta) { ctx.location.reload(); return; }
    traverse(loader.frame_id, delta, scroll()).then(snapshot => {
      if (!snapshot) return;
      this.#state = structuredClone(snapshot.state);
      this.#index = snapshot.index;
      this.#length = snapshot.length;
      set_location(snapshot.url);
      globalThis.dispatchEvent(new PopStateEvent("popstate", {state: this.#state}));
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
  get [Symbol.toStringTag]() { return "History"; }
}
