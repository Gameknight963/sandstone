import {normalize_registration,validate_registration_response,select_registration} from './registration.mjs';
import {parse_referrer_policy} from '../referrer.mjs';
import {validate_module_response} from '../frame/modules.mjs';
import {create_bootstrap_nonce} from '../bootstrap.mjs';

const canonical=scope=>{const url=new URL(scope);url.hash='';return url.href;};
const key=(origin,scope)=>JSON.stringify([origin,canonical(scope)]);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});promise.catch(()=>{});return {promise,resolve,reject};};
const abort=()=>new DOMException('Service worker registration was cleared','AbortError');
const stored=worker=>worker?Object.fromEntries(['id','scriptURL','type','source','scripts','referrerPolicy','skipWaiting'].map(name=>[name,worker[name]])):null;

export class ServiceWorkerManager{
  constructor({storage,fetch,createWorker,notify=()=>{},id=create_bootstrap_nonce}){
    Object.assign(this,{storage,fetch,createWorker,notify,id});
    this.records=new Map();this.loading=new Map();this.retired=new Set();this.tails=new Map();this.epochs=new Map();this.clients=new Map();
  }
  epoch(origin){return this.epochs.get(new URL(origin).hostname)||0;}
  valid(record){if(record.revoked||record.epoch!==this.epoch(record.origin))throw abort();record.abort.signal.throwIfAborted();}
  version(data,state){return {...data,state,pending:0,owner:null,starting:null};}
  async load(origin,scope){
    scope=canonical(scope);
    const identity=key(origin,scope),cached=this.records.get(identity);if(cached)return cached;
    const epoch=this.epoch(origin),previous=this.loading.get(identity);if(previous?.epoch===epoch)return previous.promise;
    const pending={epoch};
    pending.promise=(async()=>{
      const ticket=await this.storage.begin(origin),saved=await this.storage.read(origin,scope);
      if(epoch!==this.epoch(origin))throw abort();
      const value=saved.state,record={origin,scope,updateViaCache:value?.updateViaCache||'imports',ticket,revision:saved.revision,
        active:value?.active?this.version(value.active,'activated'):null,waiting:value?.waiting?this.version(value.waiting,'installed'):null,
        installing:null,epoch,abort:new AbortController(),revoked:false,unregistered:false};
      this.records.set(identity,record);return record;
    })();
    this.loading.set(identity,pending);
    try{return await pending.promise;}finally{if(this.loading.get(identity)===pending)this.loading.delete(identity);}
  }
  enqueue(origin,scope,action){
    const identity=key(origin,scope),previous=this.tails.get(identity)||Promise.resolve();
    const task=previous.catch(()=>{}).then(action);this.tails.set(identity,task);task.catch(()=>{});return task;
  }
  async settled(record){for(;;){const tail=this.tails.get(key(record.origin,record.scope));await tail;const activation=record.activation;await activation;if(tail===this.tails.get(key(record.origin,record.scope))&&(!record.activation||record.activation===activation))return;}}
  changed(record,event='registration',worker){this.notify({event,record,worker});}
  state(record,worker,state){
    worker.state=state;
    if(['activated','redundant'].includes(state)){
      for(const waiter of worker.skipWaiters||[])if(state==='activated')waiter.resolve();else waiter.reject(new DOMException('Worker was replaced','AbortError'));
      worker.skipWaiters?.clear();
    }
    this.changed(record,'statechange',worker);
  }
  save(record){
    const operation=(record.saving||Promise.resolve()).catch(()=>{}).then(async()=>{
      this.valid(record);if(record.unregistered)return;
      const value={scope:record.scope,updateViaCache:record.updateViaCache,active:stored(record.active),waiting:stored(record.waiting)};
      if(!value.active&&!value.waiting)return;
      const saved=await this.storage.commit(record.ticket,value,record.revision);this.valid(record);record.revision=saved.revision;
    });
    record.saving=operation;return operation;
  }
  async get(origin,scope){const record=await this.load(origin,scope);this.requestActivation(record);return record.active||record.waiting||record.installing?record:undefined;}
  async list(origin){
    for(const entry of await this.storage.list(origin))await this.load(origin,entry.scope);
    const records=[...this.records.values()].filter(record=>record.origin===origin&&!record.unregistered&&!record.revoked&&(record.active||record.waiting||record.installing));
    for(const record of records)this.requestActivation(record);return records;
  }
  describe(record){
    const version=worker=>worker?{id:worker.id,scriptURL:worker.scriptURL,state:worker.state,type:worker.type}:null;
    return {origin:record.origin,scope:record.scope,updateViaCache:record.updateViaCache,installing:version(record.installing),waiting:version(record.waiting),active:version(record.active)};
  }
  register(scriptURL,options,context){
    let normalized;try{normalized=normalize_registration(scriptURL,options,context);}catch(error){return Promise.reject(error);}
    const result=deferred(),epoch=this.epoch(normalized.origin);
    this.enqueue(normalized.origin,normalized.scope,async()=>{
      if(epoch!==this.epoch(normalized.origin))throw abort();
      const record=await this.load(normalized.origin,normalized.scope);this.valid(record);
      await this.install(record,normalized,context,result);
    }).catch(result.reject);
    return result.promise;
  }
  async resources(record,registration,context){
    const options={method:'GET',mode:'same-origin',credentials:'same-origin',redirect:'error',destination:'serviceworker',
      cache:registration.updateViaCache==='all'?'default':'no-cache',headers:{'Service-Worker':'script'},signal:record.abort.signal};
    const response=await this.fetch(registration.scriptURL,options,context);validate_registration_response(registration,response);
    const source=await response.text(),entry={url:registration.scriptURL,responseURL:response.url||registration.scriptURL,source,status:response.status,statusText:response.statusText,headers:[...response.headers],redirected:response.redirected,type:response.type};
    const incumbent=record.waiting||record.active;
    let changed=!incumbent||incumbent.scriptURL!==registration.scriptURL||incumbent.type!==registration.type||incumbent.source!==source;
    const scripts=[entry];
    if(incumbent&&incumbent.scriptURL===registration.scriptURL&&incumbent.type===registration.type)for(const previous of incumbent.scripts||[]){
      if(previous.url===registration.scriptURL)continue;
      if(!/^https?:/.test(previous.url)){scripts.push(previous);continue;}
      try{
        const imported=await this.fetch(previous.url,{method:'GET',mode:registration.type==='classic'?'no-cors':'cors',credentials:registration.type==='classic'?'include':'same-origin',
          destination:'script',cache:registration.updateViaCache==='none'?'no-cache':'default',signal:record.abort.signal},context);
        if(!imported.ok)continue;
        const mime=imported.headers.get('content-type')||'',type=/json/i.test(mime)?'json':'javascript';validate_module_response(imported,type,previous.url);
        const body=await imported.text();changed ||= body!==previous.source;
        scripts.push({url:previous.url,responseURL:imported.url||previous.url,source:body,status:imported.status,statusText:imported.statusText,headers:[...imported.headers],redirected:imported.redirected,type:imported.type,request_cross_origin:imported.request_cross_origin});
      }catch(error){if(record.abort.signal.aborted)throw error;}
    }
    this.valid(record);return {source,scripts,changed,referrerPolicy:parse_referrer_policy(response.headers.get('referrer-policy'))};
  }
  async running(record,worker,{restoring=true}={}){
    this.valid(record);if(worker.state==='redundant')throw new DOMException('Worker is redundant','InvalidStateError');
    if(worker.owner)return worker.owner;if(worker.starting)return worker.starting;
    worker.starting=this.createWorker({...stored(worker),scope:record.scope,updateViaCache:record.updateViaCache,restoring},
      {signal:record.abort.signal,command:(method,args)=>this.command(record,worker,method,args)}).then(owner=>{
        if(record.revoked||record.abort.signal.aborted){owner.close();throw abort();}
        if(worker.state==='redundant'){owner.close();throw new DOMException('Worker is redundant','InvalidStateError');}worker.owner=owner;return owner;
      }).finally(()=>worker.starting=null);
    return worker.starting;
  }
  async install(record,registration,context,result){
    const resources=await this.resources(record,registration,context);record.updateViaCache=registration.updateViaCache;
    if(!resources.changed){await this.save(record);result.resolve(record);this.requestActivation(record);return;}
    const worker=this.version({id:this.id(),scriptURL:registration.scriptURL,type:registration.type,...resources,skipWaiting:false},'parsed');
    try{
      await this.running(record,worker,{restoring:false});this.valid(record);
      record.installing=worker;this.state(record,worker,'installing');result.resolve(record);this.changed(record,'updatefound',worker);
      await this.lifecycle(record,worker,'install');this.valid(record);
      worker.scripts=await worker.owner.scripts();this.valid(record);
      const previous=record.waiting;record.waiting=worker;record.installing=null;this.state(record,worker,'installed');
      try{await this.save(record);}catch(error){record.waiting=previous;throw error;}
      if(previous){previous.owner?.close();this.state(record,previous,'redundant');}
      this.changed(record);this.requestActivation(record);
    }catch(error){
      worker.owner?.close();if(record.installing===worker)record.installing=null;
      if(record.waiting===worker)record.waiting=null;
      this.state(record,worker,'redundant');this.changed(record);
      if(!record.active&&!record.waiting)this.records.delete(key(record.origin,record.scope));
      throw error;
    }
  }
  async lifecycle(record,worker,event){
    const job=await this.dispatch(record,worker,{event});
    await job.result;await job.lifetime;
  }
  users(record){return [...this.clients.values()].filter(client=>client.registration===record);}
  requestActivation(record){
    if(record.revoked||record.unregistered||!record.waiting||record.active?.state==='activating')return;
    if(record.activation){record.activationRequested=true;return;}
    const tail=this.tails.get(key(record.origin,record.scope))||Promise.resolve();
    const task=tail.catch(()=>{}).then(()=>this.activate(record));record.activation=task;
    task.finally(()=>{if(record.activation===task)record.activation=null;if(record.activationRequested){record.activationRequested=false;this.requestActivation(record);}}).catch(()=>{});
  }
  async activate(record){
    this.valid(record);if(record.unregistered||!record.waiting||record.active?.state==='activating')return;
    if(record.active&&(record.active.pending||this.users(record).length&&!record.waiting.skipWaiting))return;
    const previous=record.active,worker=record.waiting;
    record.active=worker;record.waiting=null;this.state(record,worker,'activating');
    try{await this.save(record);}catch(error){record.active=previous;record.waiting=worker;this.state(record,worker,'installed');throw error;}
    if(previous){previous.owner?.close();this.state(record,previous,'redundant');}
    for(const client of this.users(record))this.control(client,record,worker);
    this.changed(record,'ready',worker);
    try{await this.lifecycle(record,worker,'activate');}catch(error){if(record.revoked)throw error;worker.activationError=error;}
    this.valid(record);this.state(record,worker,'activated');this.changed(record);
    if(record.waiting)this.requestActivation(record);
  }
  async dispatch(record,worker,event,{waitHandled=false}={}){
    worker.pending++;let owner,raw;
    const lost=error=>{if(['InvalidStateError','TimeoutError'].includes(error?.name)&&worker.owner===owner){owner.close(error);worker.owner=null;}};
    try{
      if(!['install','activate'].includes(event.event)&&worker.state==='activating')await record.activation;
      owner=await this.running(record,worker);raw=owner.dispatch(event);
    }catch(error){lost(error);worker.pending--;this.requestActivation(record);this.collect(record);throw error;}
    let resultDone=false,lifetimeDone=false,bodyDone=false,handledDone=!waitHandled,finished=false;
    const finish=()=>{
      if(finished||!resultDone||!lifetimeDone||!bodyDone||!handledDone)return;finished=true;worker.pending--;
      raw.release().catch(()=>{});this.requestActivation(record);this.collect(record);
    };
    const result=raw.result.then(value=>{resultDone=true;if(!(value.type==='response'&&value.body))bodyDone=true;finish();return value;},error=>{lost(error);resultDone=true;bodyDone=true;finish();throw error;});
    const lifetime=raw.lifetime.then(value=>{lifetimeDone=true;finish();return value;},error=>{lost(error);lifetimeDone=true;finish();throw error;});
    result.catch(()=>{});lifetime.catch(()=>{});
    return {...raw,result,lifetime,handled:error=>Promise.resolve().then(()=>raw.handled(error)).finally(()=>{handledDone=true;finish();}),read:()=>raw.read().then(value=>{if(value.done){bodyDone=true;finish();}return value;},error=>{bodyDone=true;finish();throw error;}),
      cancel:reason=>raw.cancel(reason).finally(()=>{bodyDone=true;finish();})};
  }
  control(client,record,worker){const changed=client.controller!==worker;client.registration=record;client.controller=worker;if(changed)this.notify({event:'controllerchange',record,worker,client});}
  addClient(client){this.clients.set(client.id,{...client,creationURL:client.creationURL||client.url,registration:null,controller:null});return this.clients.get(client.id);}
  removeClient(id){const client=this.clients.get(id);this.clients.delete(id);if(client?.registration){this.requestActivation(client.registration);this.collect(client.registration);}}
  async claim(record,worker){
    await this.list(record.origin);this.valid(record);
    if(record.active!==worker||!['activating','activated'].includes(worker.state))throw new DOMException('Worker is not active','InvalidStateError');
    for(const client of this.clients.values())if(!client.reserved&&new URL(client.creationURL).origin===record.origin){
      const matches=select_registration([...this.records.values()].filter(value=>(value.active||value.waiting||value.installing)&&!value.unregistered&&!value.revoked),client.creationURL,record.origin);
      if(matches===record)this.control(client,record,worker);
    }
  }
  command(record,worker,method,args){
    this.valid(record);
    if(method==='skipWaiting'){
      worker.skipWaiting=true;if(worker.state!=='installed')return;
      const waiter=deferred();(worker.skipWaiters??=new Set()).add(waiter);this.requestActivation(record);return waiter.promise;
    }
    if(method==='clients.claim')return this.claim(record,worker);
    if(method==='registration.unregister')return record.unregistered?false:this.unregister(record.origin,record.scope);
    if(method==='registration.update'){
      if(record.unregistered||worker.state==='installing')throw new DOMException('Worker cannot update this registration','InvalidStateError');
      return this.register(worker.scriptURL,{scope:record.scope,type:worker.type,updateViaCache:record.updateViaCache},{base:worker.scriptURL,origin:record.origin}).then(()=>undefined);
    }
    throw new DOMException('Service worker client operation is not connected','NotSupportedError');
  }
  unregister(origin,scope){return this.enqueue(origin,scope,async()=>{
    const record=await this.load(origin,scope);this.valid(record);if(record.unregistered||!record.active&&!record.waiting)return false;
    const saved=await this.storage.remove(record.ticket,record.scope,record.revision);record.revision=saved.revision;record.unregistered=true;
    this.records.delete(key(origin,scope));this.retired.add(record);
    if(record.waiting){record.waiting.owner?.close();this.state(record,record.waiting,'redundant');record.waiting=null;}
    this.changed(record);this.collect(record);return true;
  });}
  collect(record){if(record.unregistered&&!this.users(record).length&&!record.active?.pending){record.active?.owner?.close();if(record.active)this.state(record,record.active,'redundant');this.retired.delete(record);}}
  revoke(hostname){
    this.epochs.set(hostname,(this.epochs.get(hostname)||0)+1);
    for(const record of [...this.records.values(),...this.retired])if(new URL(record.origin).hostname===hostname){
      record.revoked=true;record.abort.abort(abort());for(const worker of [record.active,record.waiting,record.installing])if(worker){worker.owner?.close();this.state(record,worker,'redundant');}
      this.records.delete(key(record.origin,record.scope));this.retired.delete(record);
      for(const client of this.users(record)){client.registration=null;client.controller=null;this.notify({event:'controllerchange',record,worker:null,client});}
    }
  }
}
