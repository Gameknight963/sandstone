import { Cookie, CookieJar, domainMatch } from "tough-cookie";

const storage_key = "sandstone_site_data_v1";

// Browser storage is optional: file: and data: documents may be denied access.
export class SiteDataStore {
  constructor(storage) {
    this.storage = storage;
    this.local = Object.create(null);
    this.cookies = new CookieJar();
    this.indexed = [];
    this.persistent = false;
    this.load();
  }

  load() {
    try {
      const saved = JSON.parse(this.storage?.getItem(storage_key) || "null");
      const local = saved?.local || JSON.parse(this.storage?.getItem("proxy_local_storage") || "null");
      if (local && typeof local === "object") {
        for (const [origin, entries] of Object.entries(local)) {
          if (Array.isArray(entries)) this.local[origin] = entries;
        }
      }
      if (saved?.cookies) this.cookies = CookieJar.deserializeSync(saved.cookies);
      if (Array.isArray(saved?.indexed)) this.indexed = saved.indexed;
      this.persist();
    } catch {
      // Retain a usable in-memory session if storage is unavailable or corrupt.
    }
  }

  persist() {
    try {
      if (!this.storage) return;
      const cookies = this.cookies.serializeSync();
      // Session cookies live until this HTML document is closed.
      cookies.cookies = cookies.cookies.filter(cookie =>
        (cookie.expires && cookie.expires !== "Infinity") || typeof cookie.maxAge === "number");
      this.storage.setItem(storage_key, JSON.stringify({local: this.local, cookies, indexed: this.indexed}));
      this.persistent = true;
    } catch {
      this.persistent = false;
    }
  }

  setLocal(origin, entries) {
    this.local[origin] = entries.map(([key, value]) => [String(key), String(value)]);
    this.persist();
  }

  setCookie(url, value, http = true) {
    try {
      const cookie = this.cookies.setCookieSync(String(value), url, {http, ignoreError: true});
      this.persist();
      return cookie;
    } catch { return undefined; }
  }

  documentCookies(url) {
    const data = this.cookies.serializeSync();
    const hostname = new URL(url).hostname;
    data.cookies = data.cookies.filter(cookie => !cookie.httpOnly &&
      (cookie.hostOnly ? cookie.domain === hostname : domainMatch(hostname, cookie.domain)));
    return data;
  }

  list() {
    const sites = new Map();
    for (const [origin, entries] of Object.entries(this.local)) {
      const hostname = new URL(origin).hostname;
      if (!sites.has(hostname)) sites.set(hostname, {hostname, origins: [], cookies: 0, localStorage: 0, indexedDB: 0});
      const site = sites.get(hostname);
      site.origins.push(origin);
      site.localStorage += entries.length;
    }
    for (const data of this.cookies.serializeSync().cookies) {
      const cookie = Cookie.fromJSON(data);
      if (cookie.expiryTime() <= Date.now()) continue;
      const hostname = cookie.domain;
      if (!sites.has(hostname)) sites.set(hostname, {hostname, origins: [], cookies: 0, localStorage: 0, indexedDB: 0});
      sites.get(hostname).cookies++;
    }
    for (const database of this.indexed) {
      const hostname = new URL(database.origin).hostname;
      if (!sites.has(hostname)) sites.set(hostname, {hostname, origins: [], cookies: 0, localStorage: 0, indexedDB: 0});
      const site = sites.get(hostname);
      if (!site.origins.includes(database.origin)) site.origins.push(database.origin);
      site.indexedDB++;
    }
    return [...sites.values()].sort((a, b) => a.hostname.localeCompare(b.hostname));
  }

  clear(hostname, {cookies = true, localStorage = true} = {}) {
    if (localStorage) {
      for (const origin of Object.keys(this.local)) {
        if (new URL(origin).hostname === hostname) delete this.local[origin];
      }
      // Do not let migration resurrect data that the user has cleared.
      try { this.storage?.removeItem("proxy_local_storage"); } catch {}
    }
    if (cookies) {
      const data = this.cookies.serializeSync();
      data.cookies = data.cookies.filter(cookie => cookie.domain !== hostname);
      this.cookies = CookieJar.deserializeSync(data);
    }
    this.persist();
  }
}

let browser_storage;
try { if (typeof window !== "undefined") browser_storage = globalThis.localStorage; } catch {}
export const site_data = new SiteDataStore(browser_storage);
