import {create_bootstrap_nonce} from '../bootstrap.mjs';
import {shared_worker_options} from './options.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const aborted=()=>new DOMException('Shared worker owner is unavailable','AbortError');
export class SharedWorkerMismatchError extends Error {
  constructor(reason){super('Shared worker settings do not match');this.name='SharedWorkerMismatchError';this.reason=reason;}
}

// The trusted caller supplies the captured constructor storage key. Factory
// resources may outlive individual documents, but never their registry entry.
export class SharedWorkerRegistry {
  constructor({create,dispose=resource=>resource.close?.(),onError=()=>{},idleTimeout=5000,extendedTimeout=30000,schedule=globalThis.setTimeout.bind(globalThis),cancel=globalThis.clearTimeout.bind(globalThis)}={}){
    if(typeof create!=='function')throw new TypeError('A shared worker factory is required');
    for(const value of [idleTimeout,extendedTimeout])if(!Number.isFinite(value)||value<0||value>2147483647)throw new TypeError('Invalid shared worker timeout');
    Object.assign(this,{create,dispose,onError,idleTimeout,extendedTimeout,schedule,cancel});
    this.entries=new Map();this.ids=new Map();this.owners=new Map();
  }
  async acquire(owner,input,initialization){
    if(owner===undefined||owner===null)throw new TypeError('A shared worker owner is required');
    const storage_key=input?.storage_key,url=input?.url,secure_context=!!input?.secure_context;
    if(typeof storage_key!=='string'||!storage_key)throw new TypeError('A constructor storage key is required');
    if(typeof url!=='string')throw new TypeError('A captured constructor URL is required');
    const options=Object.freeze(shared_worker_options(input.options));
    const descriptor=Object.freeze({storage_key,url:new URL(url).href,options,secure_context});
    const key=JSON.stringify([descriptor.storage_key,descriptor.url,options.name]);
    let entry=this.entries.get(key),created=false;
    if(entry){
      for(const name of ['type','credentials','extendedLifetime'])if(entry.descriptor.options[name]!==options[name])throw new SharedWorkerMismatchError('options');
      if(entry.descriptor.secure_context!==descriptor.secure_context)throw new SharedWorkerMismatchError('secure-context');
    }else{
      created=true;
      entry={id:create_bootstrap_nonce(),key,descriptor,owners:new Map(),controller:new AbortController(),terminated:deferred(),closed:false};
      this.entries.set(key,entry);this.ids.set(entry.id,entry);
      const creation=Promise.resolve().then(()=>{
        if(entry.closed)throw entry.reason;
        return this.create(descriptor,initialization,{id:entry.id,signal:entry.controller.signal,owners:()=>[...entry.owners.keys()]});
      }).then(resource=>{
        if(!resource||!['object','function'].includes(typeof resource))throw new TypeError('A shared worker resource is required');
        if(entry.closed){this.discard(entry,resource);throw entry.reason;}
        entry.resource=resource;return resource;
      }).catch(error=>{this.close(entry.id,error);throw error;});
      entry.ready=Promise.race([creation,entry.terminated.promise]);
    }
    this.cancelIdle(entry);
    let membership=entry.owners.get(owner);
    if(!membership){
      membership=deferred();entry.owners.set(owner,membership);
      if(!this.owners.has(owner))this.owners.set(owner,new Set());this.owners.get(owner).add(entry);
    }
    const resource=await Promise.race([entry.ready,membership.promise]);
    if(entry.closed||entry.owners.get(owner)!==membership)throw aborted();
    return Object.freeze({id:entry.id,descriptor:entry.descriptor,resource,created});
  }
  cancelIdle(entry){
    const idle=entry.idle;if(!idle)return;entry.idle=undefined;
    if(idle.handle!==undefined)this.cancel(idle.handle);
  }
  forgetOwner(entry,owner,reason){
    const membership=entry.owners.get(owner);if(!membership)return;
    entry.owners.delete(owner);membership.reject(reason);
    const entries=this.owners.get(owner);entries?.delete(entry);if(!entries?.size)this.owners.delete(owner);
  }
  releaseOwner(owner){
    const entries=[...this.owners.get(owner)||[]],reason=aborted();
    for(const entry of entries){
      this.forgetOwner(entry,owner,reason);
      if(entry.owners.size||entry.closed)continue;
      const delay=entry.descriptor.options.extendedLifetime?this.extendedTimeout:this.idleTimeout;
      if(delay<=0){this.close(entry.id,reason);continue;}
      const idle={};entry.idle=idle;
      idle.handle=this.schedule(()=>{if(entry.idle===idle&&!entry.owners.size)this.close(entry.id,reason);},delay);
      idle.handle?.unref?.();
    }
    return entries.length;
  }
  discard(entry,resource){
    if(entry.disposed)return;entry.disposed=true;
    try{const result=this.dispose(resource,{id:entry.id,descriptor:entry.descriptor});result?.catch?.(error=>this.onError(error));}catch(error){this.onError(error);}
  }
  close(id,reason=aborted()){
    const entry=this.ids.get(id);if(!entry||entry.closed)return false;
    entry.closed=true;entry.reason=reason;this.ids.delete(id);
    if(this.entries.get(entry.key)===entry)this.entries.delete(entry.key);
    this.cancelIdle(entry);
    for(const owner of [...entry.owners.keys()])this.forgetOwner(entry,owner,reason);
    entry.terminated.reject(reason);entry.controller.abort(reason);
    if(entry.resource)this.discard(entry,entry.resource);
    return true;
  }
}
