import * as loader from "../loader.mjs";

export let internal = null;

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
    internal = new URL(loader.url);
    
    for (let key in internal) {
      if (typeof key === "function") continue;
      if (key === "toString") continue;

      Object.defineProperty(this, key, {
        get: () => {
          return internal[key];
        },
        set: (value) => {
          if (key === "href") {
            this.assign(value);
            return;
          }
          internal[key] = value;
          this.assign(internal.href);
        }
      })
    }
  }

  assign(url) {
    internal = new URL(url, internal);
    loader.navigate(loader.frame_id, internal.href);
  }
  replace(url) {
    this.assign(url);
  }
  reload() {
    this.assign(this.href);
  }
  toString() {
    return this.href;
  }
}
