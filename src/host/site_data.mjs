import { Cookie, CookieJar, domainMatch,canonicalDomain } from "tough-cookie";
import {http_cache} from './http_cache.mjs';
import {storage_cookie} from '../cookie.mjs';
import {apply_storage_change} from '../storage_changes.mjs';
import {SiteDataStorage,cookie_storage_key,compare_storage_order} from './site_data_storage.mjs';

const storage_key = "sandstone_site_data_v1";
const secureContexts=new Map();
const durable=cookie=>(cookie.expires&&cookie.expires!=='Infinity')||typeof cookie.maxAge==='number';
const fingerprint=cookies=>JSON.stringify(cookies.map(({lastAccessed,...cookie})=>cookie).sort((a,b)=>cookie_storage_key(a).localeCompare(cookie_storage_key(b))));
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
    this.cookieGeneration=0;this.cookieCleared=new Map();
    this.indexed = [];
    this.cacheStorage=[];
    this.serviceWorkers=[];
    this.fileSystems=[];
    this.persistent = false;
    this.localListeners=new Set();
    this.cookieListeners=new Set();this.cookieSnapshots=new Map();
    this.sessionCookies=new Map();this.cookieEpochs=new Map();
    this.load();
  }

  load() {
    try {
      const migrated=SiteDataStorage.supported(this.storage)&&SiteDataStorage.migrated(this.storage);
      const saved = migrated?null:JSON.parse(this.storage?.getItem(storage_key) || "null");
      const local = migrated?undefined:saved?.local || JSON.parse(this.storage?.getItem("proxy_local_storage") || "null");
      if (local && typeof local === "object") {
        for (const [origin, entries] of Object.entries(local)) {
          if (Array.isArray(entries)) this.local[origin] = entries;
        }
      }
      if (saved?.cookies) this.cookies = CookieJar.deserializeSync(saved.cookies);
      if (Array.isArray(saved?.indexed)) this.indexed = saved.indexed;
      if(SiteDataStorage.supported(this.storage)){
        this.persistence=new SiteDataStorage(this.storage);
        this.persistence.migrate({...saved,local});
        this.refresh(true);
      }
      this.persist();
    } catch {
      // Retain a usable in-memory session if storage is unavailable or corrupt.
      // A failed migration must not replace the full legacy snapshot with its
      // partially copied records on the next mutation.
      if(this.persistence){this.legacyStorage=this.storage;this.persistence=undefined;this.storage=undefined;}
    }
  }

  storageWrite(operation){
    if(!this.persistence)return;
    try{return operation(this.persistence);}
    catch{this.legacyStorage=this.storage;this.persistence=undefined;this.storage=undefined;this.persistent=false;}
  }

  refresh(initial=false,event){
    if(!this.persistence||this.refreshing)return;
    this.refreshing=true;
    try{
      const revision=this.persistence.revision();
      if(!initial&&!event&&revision===this.storageRevision)return;
      const snapshot=this.persistence.snapshot(),previous=this.cookies.serializeSync();
      const known=new Set(snapshot.cookies.map(cookie_storage_key));
      for(const [id,entry] of this.sessionCookies){
        if(entry.epoch!==this.persistence.cookieEpoch(entry.cookie.domain)||known.has(id))this.sessionCookies.delete(id);
        else{snapshot.cookies.push(entry.cookie);snapshot.cookieOrders.set(id,entry.order);}
      }
      snapshot.cookies.sort((a,b)=>compare_storage_order(snapshot.cookieOrders.get(cookie_storage_key(a)),snapshot.cookieOrders.get(cookie_storage_key(b))));
      const next=CookieJar.deserializeSync({...previous,cookies:snapshot.cookies});
      for(const [domain,epoch] of snapshot.epochs){
        if(!initial&&epoch!==(this.cookieEpochs.get(domain)||''))this.cookieCleared.set(domain,++this.cookieGeneration);
      }
      if(snapshot.epochs.size!==this.cookieEpochs.size||[...snapshot.epochs].some(([domain,epoch])=>this.cookieEpochs.get(domain)!==epoch))this.epochSnapshot=undefined;
      this.cookieEpochs=snapshot.epochs;
      this.storageRevision=revision;
      this.cookies=next;
      const changed=new Set();
      for(const origin of new Set([...Object.keys(this.local),...Object.keys(snapshot.local)])){
        if(JSON.stringify(this.local[origin]||[])===JSON.stringify(snapshot.local[origin]||[])){
          if(!snapshot.local[origin])delete this.local[origin];
          continue;
        }
        if(snapshot.local[origin])this.local[origin]=snapshot.local[origin];else delete this.local[origin];
        changed.add(origin);
      }
      this.indexed=snapshot.indexed;this.indexedSnapshot=JSON.stringify(this.indexed);
      if(!initial){
        if(event)changed.add(event.origin);
        for(const origin of changed)for(const listener of this.localListeners)listener(origin,this.local[origin]||[],event?.origin===origin?event.change:undefined);
        if(fingerprint(previous.cookies)!==fingerprint(snapshot.cookies))for(const listener of this.cookieListeners)listener();
      }
    }catch{this.legacyStorage=this.storage;this.persistence=undefined;this.storage=undefined;this.persistent=false;}
    finally{this.refreshing=false;}
  }

  cookieEpochSnapshot(){return this.persistence?(this.epochSnapshot??=Object.freeze(Object.fromEntries(this.cookieEpochs))):undefined;}

  persist() {
    try {
      if (!this.storage) return;
      if(this.persistence){
        const indexed=JSON.stringify(this.indexed);
        if(indexed!==this.indexedSnapshot){this.persistence.setIndexed(this.indexed);this.indexedSnapshot=indexed;}
        this.persistent=true;return;
      }
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
    this.refresh();
    this.local[origin] = entries.map(([key, value]) => [String(key), String(value)]);
    this.storageWrite(storage=>storage.setLocal(origin,this.local[origin]));
    this.persist();
    for(const listener of this.localListeners)listener(origin,this.local[origin]);
  }

  changeLocal(origin,change){
    this.refresh();
    this.local[origin]=apply_storage_change(this.local[origin],change);
    this.storageWrite(storage=>storage.changeLocal(origin,change));
    this.persist();
    for(const listener of this.localListeners)listener(origin,this.local[origin]);
  }

  setCookie(url, value, http = true, policy = {}) {
    try {
      this.refresh();
      const parsed=storage_cookie(value,policy);
      if(!parsed)return undefined;
      // An old response must not restore deleted cookies or erase replacements
      // written after an explicit clear. Other cookie domains remain writable.
      const domain=canonicalDomain(parsed.domain||new URL(url).hostname);
      if(this.persistence&&policy.cookieEpochs&&(Object.hasOwn(policy.cookieEpochs,domain)?policy.cookieEpochs[domain]:'')!==this.persistence.cookieEpoch(domain))return undefined;
      if(policy.cookieGeneration!==undefined&&(this.cookieCleared.get(domain)||0)>policy.cookieGeneration)return undefined;
      const cookie = this.cookies.setCookieSync(parsed, url, {http, ignoreError: true});
      if(cookie&&this.persistence){
        const data=cookie.toJSON(),id=cookie_storage_key(data),saved=this.storageWrite(storage=>storage.setCookie(data));
        if(durable(data))this.sessionCookies.delete(id);
        else this.sessionCookies.set(id,{cookie:data,epoch:saved?.epoch,order:saved?.order});
      }
      this.persist();
      if(cookie)for(const listener of this.cookieListeners)listener(cookie.domain);
      return cookie;
    } catch { return undefined; }
  }

  documentCookies(url, {crossSite=false} = {}) {
    this.refresh();
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
    this.refresh();
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
    for(const worker of this.serviceWorkers){
      const hostname=new URL(worker.origin).hostname;
      if(!sites.has(hostname))sites.set(hostname,{hostname,origins:[],cookies:0,localStorage:0,indexedDB:0});
      const site=sites.get(hostname);if(!site.origins.includes(worker.origin))site.origins.push(worker.origin);
      site.serviceWorkers=(site.serviceWorkers||0)+1;
    }
    for(const files of this.fileSystems){
      const hostname=new URL(files.origin).hostname;
      if(!sites.has(hostname))sites.set(hostname,{hostname,origins:[],cookies:0,localStorage:0,indexedDB:0});
      const site=sites.get(hostname);if(!site.origins.includes(files.origin))site.origins.push(files.origin);
      site.files=(site.files||0)+files.files;
    }
    return [...sites.values()].sort((a, b) => a.hostname.localeCompare(b.hostname));
  }

  clear(hostname, {cookies = true, localStorage = true} = {}) {
    this.refresh();
    http_cache.clear(hostname);
    // If migration ran out of space, ordinary writes remain in memory. The
    // explicit clear must still remove the user's old durable backup and any
    // partially migrated records rather than restoring them on the next load.
    if(this.legacyStorage){
      try{
        const saved=JSON.parse(this.legacyStorage.getItem(storage_key)||'null');
        if(saved){
          if(localStorage)for(const origin of Object.keys(saved.local||{}))if(new URL(origin).hostname===hostname)delete saved.local[origin];
          if(cookies&&saved.cookies)saved.cookies.cookies=saved.cookies.cookies.filter(cookie=>cookie.domain!==hostname);
          this.legacyStorage.setItem(storage_key,JSON.stringify(saved));
        }
        if(localStorage)this.legacyStorage.removeItem('proxy_local_storage');
        new SiteDataStorage(this.legacyStorage).clearSite(hostname,{cookies,localStorage});
      }catch{}
    }
    if(this.persistence){
      this.storageWrite(storage=>storage.clearSite(hostname,{cookies,localStorage}));
      if(this.persistence){
        this.refresh();
        if(localStorage)try{this.storage?.removeItem('proxy_local_storage');}catch{}
        this.persist();return;
      }
    }
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
      this.cookieCleared.set(hostname,++this.cookieGeneration);
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
globalThis.addEventListener?.('storage',event=>{
  if(event.storageArea===browser_storage&&(event.key===null||event.key.startsWith('sandstone_site_data_v2:')))site_data.refresh(false,site_data.persistence?.storageEvent(event));
});
