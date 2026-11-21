import { Cookie, CookieJar, domainMatch,canonicalDomain } from "tough-cookie";
import {http_cache} from './http_cache.mjs';
import {storage_cookie,cookie_snapshot,set_cookie} from '../cookie.mjs';
import {apply_storage_change} from '../storage_changes.mjs';
import {SiteDataStorage,cookie_storage_key,compare_storage_order} from './site_data_storage.mjs';
import {CookieSession} from './cookie_session.mjs';
import {create_bootstrap_nonce} from '../bootstrap.mjs';

const storage_key = "sandstone_site_data_v1";
const session_key='sandstone_session_cookies_v1';
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
  constructor(storage,{sessionStorage,Channel,locks}={}) {
    this.storage = storage;
    this.sessionStorage=sessionStorage;
    this.local = Object.create(null);
    this.cookies = new CookieJar();
    this.cookieGeneration=0;this.cookieCleared=new Map();
    this.cookieVersions=new Map();this.cookieVersionSequence=0;
    this.indexed = [];
    this.cacheStorage=[];
    this.serviceWorkers=[];
    this.fileSystems=[];
    this.persistent = false;
    this.localListeners=new Set();
    this.cookieListeners=new Set();this.cookieSnapshots=new Map();
    this.sessionCookies=new Map();this.pendingSessionCookies=new Map();this.cookieEpochs=new Map();
    try{
      const entries=JSON.parse(sessionStorage?.getItem(session_key)||'[]');
      if(Array.isArray(entries))for(const pair of entries){
        if(!Array.isArray(pair)||pair.length!==2)continue;
        const [id,entry]=pair;
        if(entry&&typeof entry.epoch==='string'&&Array.isArray(entry.order)&&entry.order.length===3&&Number.isFinite(entry.order[0])&&Number.isFinite(entry.order[1])&&typeof entry.order[2]==='string'&&Cookie.fromJSON(entry.cookie)&&cookie_storage_key(entry.cookie)===id)this.sessionCookies.set(id,entry);
      }
    }catch{}
    this.load();
    this.ready=Promise.resolve();
    if(this.persistence&&Channel&&locks){
      this.cookieSession=new CookieSession({Channel,locks,snapshot:()=>{this.refresh();return [...this.sessionCookies];},receive:entries=>this.receiveSessionCookies(entries)});
      this.ready=this.cookieSession.ready;
    }
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
      if (saved?.cookies) this.cookies = CookieJar.deserializeSync(cookie_snapshot(saved.cookies));
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
      // BroadcastChannel and native storage events can reach another process
      // in either order. Retain newer snapshots until its storage cache sees
      // the corresponding record; never install a cookie without that match.
      for(const [id,entry] of this.pendingSessionCookies){
        const order=snapshot.cookieOrders.get(id);if(!order)continue;
        const comparison=compare_storage_order(entry.order,order);
        if(comparison>0)continue;
        this.pendingSessionCookies.delete(id);
        if(comparison===0&&!known.has(id)&&entry.epoch===(snapshot.epochs.get(entry.cookie.domain)||''))this.sessionCookies.set(id,entry);
      }
      for(const [id,entry] of this.sessionCookies){
        const order=snapshot.cookieOrders.get(id);
        if(entry.epoch!==this.persistence.cookieEpoch(entry.cookie.domain)||known.has(id)||!order||compare_storage_order(entry.order,order)!==0)this.sessionCookies.delete(id);
        else{snapshot.cookies.push(entry.cookie);snapshot.cookieOrders.set(id,entry.order);}
      }
      snapshot.cookies.sort((a,b)=>compare_storage_order(snapshot.cookieOrders.get(cookie_storage_key(a)),snapshot.cookieOrders.get(cookie_storage_key(b))));
      const normalized=cookie_snapshot({...previous,cookies:snapshot.cookies});
      const next=CookieJar.deserializeSync(normalized);
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
      this.saveSessionCookies();
      if(!initial){
        if(event)changed.add(event.origin);
        for(const origin of changed)for(const listener of this.localListeners)listener(origin,this.local[origin]||[],event?.origin===origin?event.change:undefined);
        if(fingerprint(previous.cookies)!==fingerprint(normalized.cookies))for(const listener of this.cookieListeners)listener();
      }
    }catch{this.legacyStorage=this.storage;this.persistence=undefined;this.storage=undefined;this.persistent=false;}
    finally{this.refreshing=false;}
  }

  cookieEpochSnapshot(){return this.persistence?(this.epochSnapshot??=Object.freeze(Object.fromEntries(this.cookieEpochs))):undefined;}

  persist() {
    this.saveSessionCookies();
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

  saveSessionCookies(){
    // Native sessionStorage survives reloads of this host without turning a
    // remote session cookie into durable, cross-browser-session site data.
    try{this.sessionStorage?.setItem(session_key,JSON.stringify([...this.sessionCookies]));}catch{}
    this.cookieSession?.changed();
  }

  receiveSessionCookies(entries){
    if(!this.persistence)return;
    for(const pair of entries){
      if(!Array.isArray(pair)||pair.length!==2)continue;
      const [id,entry]=pair;
      try{
        if(!entry||typeof entry.epoch!=='string'||!Array.isArray(entry.order)||entry.order.length!==3||!Number.isFinite(entry.order[0])||!Number.isFinite(entry.order[1])||typeof entry.order[2]!=='string'||cookie_storage_key(entry.cookie)!==id||!Cookie.fromJSON(entry.cookie)||durable(entry.cookie))continue;
        const previous=this.pendingSessionCookies.get(id);
        if(!previous||compare_storage_order(entry.order,previous.order)>=0)this.pendingSessionCookies.set(id,entry);
      }catch{}
    }
    this.storageRevision=undefined;this.refresh();
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

  cookiePolicyAuthority(){return this.persistence?'persistent':(this.cookieActor??=create_bootstrap_nonce());}

  cookiePolicyAllows(domain,policy){
    if(policy.cookieAuthority&&policy.cookieAuthority!==this.cookiePolicyAuthority())return false;
    if(this.persistence&&policy.cookieEpochs&&(Object.hasOwn(policy.cookieEpochs,domain)?policy.cookieEpochs[domain]:'')!==this.persistence.cookieEpoch(domain))return false;
    return policy.cookieGeneration===undefined||(this.cookieCleared.get(domain)||0)<=policy.cookieGeneration;
  }

  cookieVersion(cookie){
    return this.persistence?this.persistence.cookieVersion(cookie):{epoch:String(this.cookieCleared.get(cookie.domain)||0),version:this.cookieVersions.get(cookie_storage_key(cookie))||''};
  }

  // Prepare without changing the jar. A retry carries the same version and
  // timestamp, so it cannot replay a committed write over a newer cookie.
  prepareCookie(url,value,http=true,policy={}){
    try{
      // A peer's atomic cookie record can arrive before its revision event.
      // Bind both the payload and version to that same current storage view.
      if(this.persistence)this.storageRevision=undefined;
      this.refresh();value=String(value);url=new URL(url).href;
      const time=Date.now(),parsed=storage_cookie(value,{...policy,now:time});if(!parsed)return null;
      const domain=canonicalDomain(parsed.domain||new URL(url).hostname);
      if(!this.cookiePolicyAllows(domain,policy))return null;
      const cookie=set_cookie(this.cookies.cloneSync(),parsed,url,{http,ignoreError:true,now:new Date(time)});
      if(!cookie)return null;
      const {epoch,version}=this.cookieVersion(cookie);
      return {id:create_bootstrap_nonce(),authority:this.cookiePolicyAuthority(),key:cookie_storage_key(cookie),epoch,previous:version,time,cookie:cookie.toJSON(),url,value,http:!!http};
    }catch{return null;}
  }

  setCookie(url, value, http = true, policy = {}) {
    try {
      if(policy.cookieWrite&&this.persistence)this.storageRevision=undefined;
      this.refresh();
      value=String(value);
      const write=policy.cookieWrite,time=write?.time??Date.now();
      const parsed=storage_cookie(value,{...policy,now:time});
      if(!parsed)return undefined;
      // An old response must not restore deleted cookies or erase replacements
      // written after an explicit clear. Other cookie domains remain writable.
      const domain=canonicalDomain(parsed.domain||new URL(url).hostname);
      if(!this.cookiePolicyAllows(domain,policy))return undefined;
      if(write){
        if(typeof write.id!=='string'||!write.id||write.value!==value||write.url!==new URL(url).href||write.http!==!!http)return undefined;
        const candidate=set_cookie(this.cookies.cloneSync(),parsed,url,{http,ignoreError:true,now:new Date(write.time)});
        if(!candidate||write.key!==cookie_storage_key(candidate)||write.authority!==this.cookiePolicyAuthority())return undefined;
        const current=this.cookieVersion(candidate);
        if(current.epoch!==write.epoch)return undefined;
        if(current.version===write.id){
          // A session payload may have died with its first provider after its
          // private storage tombstone committed but before its broadcast.
          if(this.persistence&&!durable(write.cookie)&&!this.sessionCookies.has(write.key)&&cookie_storage_key(write.cookie)===write.key){
            const data=this.cookies.serializeSync();data.cookies=data.cookies.filter(cookie=>cookie_storage_key(cookie)!==write.key);data.cookies.push(write.cookie);
            this.cookies=CookieJar.deserializeSync(data);
            this.sessionCookies.set(write.key,{cookie:write.cookie,epoch:current.epoch,order:current.order});
            this.storageRevision=undefined;this.refresh();
            this.persist();for(const listener of this.cookieListeners)listener(candidate.domain);
          }
          return undefined;
        }
        if(current.version!==write.previous)return undefined;
      }
      const cookie = set_cookie(this.cookies,parsed, url, {http, ignoreError: true,now:new Date(time)});
      if(cookie&&this.persistence){
        const data=cookie.toJSON(),id=cookie_storage_key(data),saved=this.storageWrite(storage=>storage.setCookie(data,write?.id));
        if(durable(data))this.sessionCookies.delete(id);
        else this.sessionCookies.set(id,{cookie:data,epoch:saved?.epoch,order:saved?.order});
      }
      if(cookie&&!this.persistence)this.cookieVersions.set(cookie_storage_key(cookie),write?.id||String(++this.cookieVersionSequence));
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
      for(const [id,entry] of this.sessionCookies)if(entry.cookie.domain===hostname)this.sessionCookies.delete(id);
      for(const id of this.cookieVersions.keys())if(JSON.parse(id)[0]===hostname)this.cookieVersions.delete(id);
      for(const listener of this.cookieListeners)listener(hostname);
    }
    this.persist();
  }
}

let browser_storage,browser_session_storage,browser_locks;
try { if (typeof window !== "undefined") browser_storage = globalThis.localStorage; } catch {}
try { if (typeof window !== "undefined") browser_session_storage = globalThis.sessionStorage; } catch {}
try { if (typeof window !== "undefined") browser_locks = globalThis.navigator?.locks; } catch {}
export const site_data = new SiteDataStore(browser_storage,{sessionStorage:browser_session_storage,Channel:globalThis.BroadcastChannel,locks:browser_locks});
globalThis.addEventListener?.('storage',event=>{
  if(event.storageArea===browser_storage&&(event.key===null||event.key.startsWith('sandstone_site_data_v2:')))site_data.refresh(false,site_data.persistence?.storageEvent(event));
});
