import {getPublicSuffix} from 'tough-cookie';
import {MemoryLockManager} from './manager.mjs';
import {create_bootstrap_nonce} from '../bootstrap.mjs';

export class LockService {
  constructor({contexts,manager=globalThis.navigator?.locks}){
    this.contexts=contexts;this.manager=manager||new MemoryLockManager();this.entries=new Set();this.clients=new WeakMap();
    this.nativeClientId='memory-host';
    // Native locks coordinate separate standalone-file tabs as well. Learn
    // this host's native client so snapshots can restore its frame identities.
    const probe='sandstone.locks.client:'+create_bootstrap_nonce();
    this.ready=manager?this.manager.request(probe,{},async()=>{
      const snapshot=await this.manager.query();this.nativeClientId=snapshot.held.find(info=>info.name===probe)?.clientId;
    }):Promise.resolve();
    this.ready.catch(()=>{});
  }
  scope(token){
    const context=this.contexts().get(token);
    if(!context||context.retired)throw new DOMException('Lock document is unavailable','InvalidStateError');
    const info=context.context,origin=info.broadcast_origin||new URL(info.url).origin;
    if(origin==='null'||origin.startsWith('opaque:'))throw new DOMException('Lock origin is unavailable','SecurityError');
    const top=new URL(info.top_url||info.url),site=top.protocol+'//'+(getPublicSuffix(top.hostname,{ignoreError:true})||top.hostname);
    return {context,prefix:JSON.stringify(['sandstone.locks.v1',site,origin])+':'};
  }
  open(token,name,options,port){
    const {context,prefix}=this.scope(token);
    if(typeof name!=='string'||name.startsWith('-')||!options||!['exclusive','shared'].includes(options.mode)||options.steal&&(options.ifAvailable||options.mode!=='exclusive'))throw new TypeError('Invalid lock request');
    if(!this.clients.has(context))this.clients.set(context,create_bootstrap_nonce());
    const entry={context,port,name,key:prefix+JSON.stringify(name),mode:options.mode,controller:new AbortController(),held:false};
    this.entries.add(entry);
    port.onmessage=event=>{
      if(event.data==='release')entry.release?.();
      else if(event.data==='cancel'){entry.controller.abort();entry.release?.();}
    };
    port.start();
    const finish=error=>{
      if(!this.entries.delete(entry))return;
      entry.release?.();
      port.postMessage(error?{type:'error',name:error.name,message:error.message}:{type:'released'});port.close();
    };
    this.ready.then(()=>this.manager.request(entry.key,{mode:options.mode,ifAvailable:!!options.ifAvailable,steal:!!options.steal,...(!options.ifAvailable&&!options.steal?{signal:entry.controller.signal}:{})},lock=>{
      if(!this.entries.has(entry)||entry.controller.signal.aborted)return;
      entry.held=!!lock;
      return new Promise(resolve=>{entry.release=resolve;port.postMessage({type:'granted',lock:lock?{name,mode:entry.mode}:null});});
    })).then(()=>finish(),finish);
  }
  async query(token){
    const {prefix}=this.scope(token);await this.ready;const snapshot=await this.manager.query(),used=new Set();
    return Object.fromEntries(['held','pending'].map(kind=>[kind,snapshot[kind].filter(info=>info.name.startsWith(prefix)).map(info=>{
      const own=info.clientId===this.nativeClientId?[...this.entries].find(entry=>!used.has(entry)&&entry.key===info.name&&entry.mode===info.mode&&entry.held===(kind==='held')):null;
      if(own)used.add(own);
      return {...info,name:JSON.parse(info.name.slice(prefix.length)),clientId:own?this.clients.get(own.context):info.clientId};
    })]));
  }
  disconnect(frame){
    for(const entry of this.entries)if(entry.context.frame===frame){
      this.entries.delete(entry);entry.controller.abort();entry.release?.();entry.port.close();
    }
  }
}
