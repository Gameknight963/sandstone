import {IDBFactory} from 'fake-indexeddb';
import {normalize_registration} from './registration.mjs';
import {trustworthy_url} from '../trustworthy.mjs';

const name='sandstone:service-workers:v1';
function principal(origin){
  const url=new URL(origin);
  if(url.origin!==origin||!trustworthy_url(url)||!['http:','https:'].includes(url.protocol))throw new DOMException('Service worker storage origin is unavailable','SecurityError');
  return url;
}
function snapshot(origin,state){
  if(!state||state.installing)throw new TypeError('Only installed service workers can be persisted');
  const entry=state.active||state.waiting;
  if(!entry)throw new TypeError('A registration needs an installed worker');
  const registration=normalize_registration(entry.scriptURL,{scope:state.scope,type:entry.type,updateViaCache:state.updateViaCache},{base:origin+'/',origin});
  const version=value=>{
    if(value==null)return null;
    const normalized=normalize_registration(value.scriptURL,{scope:registration.scope,type:value.type,updateViaCache:registration.updateViaCache},{base:origin+'/',origin});
    if(typeof value.id!=='string'||!value.id||typeof value.source!=='string')throw new TypeError('Invalid installed service worker');
    if(value.scripts!==undefined&&!Array.isArray(value.scripts))throw new TypeError('Invalid service worker script snapshots');
    const scripts=(value.scripts||[]).map(script=>{
      const url=new URL(script.url);
      if(!['http:','https:','data:','blob:'].includes(url.protocol)||typeof script.source!=='string')throw new TypeError('Invalid service worker script snapshot');
      return {...script,url:url.href};
    });
    return {...value,scriptURL:normalized.scriptURL,type:normalized.type,scripts};
  };
  const active=version(state.active),waiting=version(state.waiting);
  if(active&&waiting&&active.id===waiting.id)throw new TypeError('Active and waiting workers must be distinct versions');
  return structuredClone({origin,scope:registration.scope,updateViaCache:registration.updateViaCache,active,waiting});
}

// One native transaction commits the registration and all of its script
// snapshots. Tombstones prevent an older install from undoing unregister;
// origin generations prevent in-flight work from undoing per-site clearing.
export class ServiceWorkerStorage{
  constructor(factory,{onCatalog=()=>{}}={}){
    this.factory=factory;this.persistent=!!factory;this.onCatalog=onCatalog;this.closed=false;
    this.ready=this.open(factory);
  }
  async open(factory){
    const connect=factory=>new Promise((resolve,reject)=>{
      let abandoned=false;
      const request=factory.open(name,1);
      request.onupgradeneeded=()=>{
        try{
          const db=request.result;
          db.createObjectStore('origins',{keyPath:'origin'});
          db.createObjectStore('registrations',{keyPath:['origin','scope']}).createIndex('origin','origin');
        }catch(error){abandoned=true;try{request.transaction.abort();}catch{}reject(error);}
      };
      request.onerror=()=>reject(request.error);
      request.onblocked=()=>{abandoned=true;reject(new DOMException('Service worker database is blocked','InvalidStateError'));};
      request.onsuccess=()=>{if(abandoned)request.result.close();else resolve(request.result);};
    });
    try{this.db=await connect(factory);}catch(error){
      if(error?.name==='VersionError')throw error;
      this.factory=new IDBFactory();this.persistent=false;this.db=await connect(this.factory);
    }
    if(this.closed)this.db.close();
    this.db.onversionchange=()=>this.close();
  }
  async transaction(mode,action){
    await this.ready;
    if(this.closed)throw new DOMException('Service worker storage is closed','InvalidStateError');
    return new Promise((resolve,reject)=>{
      const tx=this.db.transaction(['origins','registrations'],mode);let result,failure;
      const fail=error=>{failure=error;try{tx.abort();}catch{reject(error);}};
      const guard=callback=>(...args)=>{try{return callback(...args);}catch(error){fail(error);}};
      tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(failure||tx.error||new DOMException('Service worker transaction aborted','AbortError'));
      try{action(tx,value=>result=value,fail,guard);}catch(error){fail(error);}
    });
  }
  async begin(origin){
    principal(origin);
    return this.transaction('readwrite',(tx,done,fail,guard)=>{
      const store=tx.objectStore('origins'),request=store.get(origin);
      request.onsuccess=guard(()=>{const entry=request.result||{origin,generation:0};store.put(entry);done({...entry});});
    });
  }
  async read(origin,scope){
    principal(origin);const url=new URL(scope);url.hash='';if(url.origin!==origin)throw new DOMException('Service worker scope changed origin','SecurityError');
    return this.transaction('readonly',(tx,done,fail,guard)=>{
      const request=tx.objectStore('registrations').get([origin,url.href]);
      request.onsuccess=guard(()=>done(request.result||{origin,scope:url.href,revision:0,state:null}));
    });
  }
  async commit(ticket,state,revision){
    const origin=ticket?.origin;principal(origin);const saved=snapshot(origin,state);
    if(!Number.isSafeInteger(revision)||revision<0)throw new TypeError('A registration revision is required');
    const result=await this.write(ticket,saved.scope,revision,saved);await this.catalog();return result;
  }
  async remove(ticket,scope,revision){
    principal(ticket?.origin);const url=new URL(scope);url.hash='';if(url.origin!==ticket.origin)throw new DOMException('Service worker scope changed origin','SecurityError');
    const result=await this.write(ticket,url.href,revision,null);await this.catalog();return result;
  }
  async write(ticket,scope,revision,state){
    if(!Number.isSafeInteger(revision)||revision<0||revision===Number.MAX_SAFE_INTEGER)throw new TypeError('A valid registration revision is required');
    return this.transaction('readwrite',(tx,done,fail,guard)=>{
      const origins=tx.objectStore('origins'),registrations=tx.objectStore('registrations'),generation=origins.get(ticket.origin);
      generation.onsuccess=guard(()=>{
        if(!generation.result||generation.result.generation!==ticket.generation){fail(new DOMException('Site data was cleared','AbortError'));return;}
        const current=registrations.get([ticket.origin,scope]);
        current.onsuccess=guard(()=>{
          const value=current.result;
          if((value?.revision||0)!==revision){fail(new DOMException('Registration changed during update','InvalidStateError'));return;}
          const result={origin:ticket.origin,scope,revision:revision+1,state};registrations.put(result);done(result);
        });
      });
    });
  }
  async catalog(){
    const catalog=await this.transaction('readonly',(tx,done,fail,guard)=>{
      const request=tx.objectStore('registrations').getAll();
      request.onsuccess=guard(()=>done(request.result.filter(entry=>entry.state).map(entry=>({origin:entry.origin,scope:entry.scope}))));
    });
    this.onCatalog(catalog);return catalog;
  }
  async list(origin){
    if(origin!==undefined)principal(origin);
    return this.transaction('readonly',(tx,done,fail,guard)=>{
      const store=tx.objectStore('registrations'),request=origin===undefined?store.getAll():store.index('origin').getAll(origin);
      request.onsuccess=guard(()=>done(request.result.filter(entry=>entry.state)));
    });
  }
  async clear(hostname){
    await this.transaction('readwrite',(tx,done,fail,guard)=>{
      const origins=tx.objectStore('origins'),registrations=tx.objectStore('registrations'),request=origins.getAll();
      request.onsuccess=guard(()=>{
        for(const entry of request.result)if(new URL(entry.origin).hostname===hostname){
          origins.put({...entry,generation:entry.generation+1});
          const cursor=registrations.index('origin').openCursor(entry.origin);
          cursor.onsuccess=guard(()=>{if(cursor.result){cursor.result.delete();cursor.result.continue();}});
        }
        done();
      });
    });
    await this.catalog();
  }
  close(){this.closed=true;this.db?.close();}
}
