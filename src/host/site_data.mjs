import { Cookie, CookieJar, domainMatch,canonicalDomain } from "tough-cookie";
import {http_cache} from './http_cache.mjs';
import {storage_cookie} from '../cookie.mjs';
import {apply_storage_change} from '../storage_changes.mjs';

const storage_key = "sandstone_site_data_v1";
const secureContexts=new Map();
function secure_cookie_context(source,allowSecureOnLocal){
  if(source.protocol==='https:'||source.protocol==='wss:')return true;
  const key=source.origin+':'+allowSecureOnLocal;
  if(!secureContexts.has(key)){
    // Ask the jar for its trust decision without touching real cookies or their
    // access timestamps. This includes loopback and *.localhost exceptions.
    const probe=new CookieJar(undefined,{allowSecureOnLocal});
    probe.setCookieSync('probe=1; Secure; Path=/',source.href,{ignoreError:true});
    secureContexts.set(key,probe.getCookiesSync(source.href).some(cookie=>cookie.secure));
  }
  return secureContexts.get(key);
}

// Browser storage is optional: file: and data: documents may be denied access.
export class SiteDataStore {
  constructor(storage) {
    this.storage = storage;
    this.local = Object.create(null);
    this.cookies = new CookieJar();
    this.indexed = [];
    this.cacheStorage=[];
    this.persistent = false;
    this.localListeners=new Set();
    this.cookieListeners=new Set();this.cookieSnapshots=new Map();
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
    for(const listener of this.localListeners)listener(origin,this.local[origin]);
  }

  changeLocal(origin,change){this.setLocal(origin,apply_storage_change(this.local[origin],change));}

  setCookie(url, value, http = true, policy = {}) {
    try {
      const parsed=storage_cookie(value,policy);
      if(!parsed)return undefined;
      const cookie = this.cookies.setCookieSync(parsed, url, {http, ignoreError: true});
      this.persist();
      if(cookie)for(const listener of this.cookieListeners)listener(cookie.domain);
      return cookie;
    } catch { return undefined; }
  }

  documentCookies(url, {crossSite=false} = {}) {
    const data = this.cookies.serializeSync();
    const source=new URL(url),hostname=canonicalDomain(source.hostname);
    data.cookies = data.cookies.filter(cookie => !cookie.httpOnly && (!cookie.secure||secure_cookie_context(source,this.cookies.allowSecureOnLocal)) && (!crossSite||cookie.sameSite==='none'&&cookie.secure) &&
      (cookie.hostOnly ? cookie.domain === hostname : domainMatch(hostname, cookie.domain)));
    // A document's clock must not reveal changes in unrelated sites or hidden
    // HttpOnly/Secure cookies. Access timestamps are not script-visible changes.
    const key=source.origin+':'+crossSite,fingerprint=JSON.stringify(data.cookies.map(({lastAccessed,...cookie})=>cookie));
    let previous=this.cookieSnapshots.get(key);
    if(!previous)this.cookieSnapshots.set(key,previous={fingerprint,revision:0});
    else if(previous.fingerprint!==fingerprint){previous.fingerprint=fingerprint;previous.revision++;}
    data.sandstone_revision=previous.revision;
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
    for(const cache of this.cacheStorage){
      const hostname=new URL(cache.origin).hostname;
      if(!sites.has(hostname))sites.set(hostname,{hostname,origins:[],cookies:0,localStorage:0,indexedDB:0});
      const site=sites.get(hostname);if(!site.origins.includes(cache.origin))site.origins.push(cache.origin);
      site.cacheStorage=(site.cacheStorage||0)+1;
    }
    return [...sites.values()].sort((a, b) => a.hostname.localeCompare(b.hostname));
  }

  clear(hostname, {cookies = true, localStorage = true} = {}) {
    http_cache.clear(hostname);
    if (localStorage) {
      for (const origin of Object.keys(this.local)) {
        if (new URL(origin).hostname === hostname) {
          delete this.local[origin];
          for(const listener of this.localListeners)listener(origin,[]);
        }
      }
      // Do not let migration resurrect data that the user has cleared.
      try { this.storage?.removeItem("proxy_local_storage"); } catch {}
    }
    if (cookies) {
      const data = this.cookies.serializeSync();
      data.cookies = data.cookies.filter(cookie => cookie.domain !== hostname);
      this.cookies = CookieJar.deserializeSync(data);
      for(const listener of this.cookieListeners)listener(hostname);
    }
    this.persist();
  }
}

let browser_storage;
try { if (typeof window !== "undefined") browser_storage = globalThis.localStorage; } catch {}
export const site_data = new SiteDataStore(browser_storage);
