import * as loader from "../loader.mjs";
import { ctx } from "../context.mjs";

export let internal = null;
export function set_location(value) { internal = new URL(value); loader.set_url(internal.href); }

export class FakeWorkerLocation {
  constructor() {
    const url = new URL(loader.url);
    for (const key of ["href", "origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash"]) {
      Object.defineProperty(this, key, {enumerable: true, get: () => key === "origin" ? loader.worker_origin || url.origin : url[key]});
    }
  }
  toString() { return this.href; }
  get [Symbol.toStringTag]() { return "WorkerLocation"; }
}

export class FakeLocation {
  constructor() {
    set_location(loader.url);
    for (const key of ["href", "origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash"]) {
      const descriptor = {enumerable: true, get: () => internal[key]};
      if (key !== "origin") descriptor.set = value => {
        if (key === "href") { this.assign(value); return; }
        const next = new URL(internal);
        next[key] = value;
        if (key === "hash" && next.href === internal.href) return;
        this.assign(next.href);
      };
      Object.defineProperty(this, key, descriptor);
    }
  }
  #navigate(value, mode) {
    const next = new URL(value, internal);
    const same_base = next.origin === internal.origin && next.pathname === internal.pathname && next.search === internal.search;
    if (same_base && (next.hash !== internal.hash || next.hash || String(value).startsWith("#"))) {
      ctx.history._hash(next.href, mode === "replace");
      return;
    }
    loader.navigate(loader.frame_id, next.href, true, null, {history_mode: mode, scroll: [globalThis.scrollX || 0, globalThis.scrollY || 0]}).catch(console.error);
  }
  assign(value) { this.#navigate(value, "push"); }
  replace(value) { this.#navigate(value, "replace"); }
  reload() { loader.navigate(loader.frame_id, this.href, true, null, {history_mode: "reload", scroll: [globalThis.scrollX || 0, globalThis.scrollY || 0]}).catch(console.error); }
  toString() { return this.href; }
  get [Symbol.toStringTag]() { return "Location"; }
}
