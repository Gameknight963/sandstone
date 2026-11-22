import {SharedWorkerRegistry} from './registry.mjs';
import {create_bootstrap_nonce} from '../bootstrap.mjs';

export const delegate_prefix='sandstone.actor-delegate.v1:';
const unavailable=()=>new DOMException('Shared worker UI is unavailable','AbortError');

class Delegate{
  constructor(port,onClose,onNotice){
    this.port=port;this.pending=new Map();this.sequence=0;this.onClose=onClose;
    this.receive=event=>{
      const reply=event.data;
      if(reply?.type==='closed'){this.close();return;}
      if(reply?.type==='owner-closed'||reply?.type==='constructor-error'){onNotice(reply);return;}
      const call=this.pending.get(reply?.id);
      if(reply?.type!=='reply'||!call){for(const port of event.ports)port.close();return;}
      this.pending.delete(reply.id);
      if(reply.ok)call.resolve({value:reply.value,ports:event.ports});
      else{for(const port of event.ports)port.close();const error=new Error(reply.error?.message||'Shared worker UI request failed');error.name=reply.error?.name||'Error';call.reject(error);}
    };
    port.addEventListener('message',this.receive);port.start();
  }
  request(op,message){
    return new Promise((resolve,reject)=>{
      if(this.closed){reject(unavailable());return;}
      const id=++this.sequence;this.pending.set(id,{resolve,reject});
      try{this.port.postMessage({type:'request',id,op,...message});}catch(error){this.pending.delete(id);reject(error);}
    });
  }
  close(){
    if(this.closed)return;this.closed=true;
    this.port.removeEventListener('message',this.receive);try{this.port.postMessage({type:'closed'});}catch{}this.port.close();
    for(const call of this.pending.values())call.reject(unavailable());this.pending.clear();this.onClose();
  }
}

// Only trusted host delegates may join. Constructors are side effects: a lost
// delegate rejects its requests instead of replaying them on another UI.
export class SharedWorkerOwners{
  constructor({createProfile,locks=globalThis.navigator?.locks,onError=()=>{},onUIClosed=()=>{},...options}={}){
    if(typeof createProfile!=='function')throw new TypeError('A native actor profile factory is required');
    this.uis=new Map();this.resources=new Set();this.locks=locks;this.onError=onError;this.onUIClosed=onUIClosed;
    this.registry=new SharedWorkerRegistry({...options,onError,create:async(descriptor,initialization,scope)=>{
      const input=await createProfile(descriptor,initialization,scope),url=new URL(input.url);
      if(url.protocol!=='data:')throw new DOMException('Shared worker actors must use opaque data URLs','SecurityError');
      url.hash='sandstone-actor='+scope.id;
      const profile=Object.freeze({...input,url:url.href,name:descriptor.options.name,credentials:descriptor.options.credentials,extendedLifetime:descriptor.options.extendedLifetime});
      const resource={id:scope.id,profile,uis:new Map(),users:new Map(),closed:false};this.resources.add(resource);
      resource.close=async()=>{
        if(resource.closed)return;resource.closed=true;this.resources.delete(resource);
        for(const ui of this.uis.values())for(const owner of resource.users.keys())if(!this.registry.owners.has(owner))ui.owners.delete(owner);
        const uis=[...resource.uis.keys()];resource.uis.clear();resource.users.clear();
        await Promise.all(uis.map(id=>this.uis.get(id)?.channel.request('close',{actor:scope.id}).catch(error=>{if(this.uis.has(id))onError(error);})));
      };
      return resource;
    }});
  }
  addUI(port,{lease,signal}={}){
    if(this.closed)throw unavailable();
    if(!(port instanceof MessagePort)||!lease&&!signal||signal&&(typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function')||lease&&(typeof lease!=='string'||!lease.startsWith(delegate_prefix)||typeof this.locks?.request!=='function'))throw new TypeError('A private UI port and lifetime are required');
    const id=create_bootstrap_nonce(),ui={id,owners:new Set()},watch=new AbortController();
    const gone=()=>{
      watch.abort();signal?.removeEventListener('abort',abort);this.uis.delete(id);
      for(const owner of ui.owners){this.registry.releaseOwner(owner);for(const resource of this.resources)resource.users.delete(owner);}ui.owners.clear();
      for(const resource of this.resources)resource.uis.delete(id);
      this.onUIClosed(id);
    };
    const notice=message=>{
      if(message.type==='owner-closed'){for(const resource of this.resources)if(resource.id===message.actor)resource.uis.delete(id);}
      else if(message.type==='constructor-error')this.onError({...message,ui:id});
    };
    ui.channel=new Delegate(port,gone,notice);this.uis.set(id,ui);
    const abort=()=>ui.channel.close();signal?.addEventListener('abort',abort,{once:true});
    try{
      if(lease)this.locks.request(lease,{signal:watch.signal},abort).catch(()=>{if(!watch.signal.aborted)abort();});
      if(signal?.aborted)abort();
    }catch(error){abort();throw error;}
    return {id,close:abort};
  }
  owner(ui,document){
    if(typeof document!=='string'||!document)throw new TypeError('A logical worker document is required');
    return JSON.stringify([ui.id,document]);
  }
  async acquire(id,document,descriptor,initialization){
    const ui=this.uis.get(id);if(!ui||this.closed)throw unavailable();
    const owner=this.owner(ui,document);ui.owners.add(owner);
    let acquired;
    try{acquired=await this.registry.acquire(owner,descriptor,initialization);}
    catch(error){if(!this.registry.owners.has(owner))ui.owners.delete(owner);throw error;}
    const entry=this.registry.ids.get(acquired.id),membership=entry?.owners.get(owner),resource=acquired.resource;
    const current=()=>!!membership&&this.uis.get(id)===ui&&!resource.closed&&entry?.owners.get(owner)===membership;
    if(!current())throw unavailable();
    let usage=resource.users.get(owner);if(!usage){usage={pending:0,connected:false};resource.users.set(owner,usage);}usage.pending++;
    const connecting=(async()=>{
      let creating=resource.uis.get(id);
      if(!creating){
        creating=ui.channel.request('owner',{actor:resource.id,profile:resource.profile}).then(result=>{
          if(result.ports.length){for(const port of result.ports)port.close();throw new TypeError('Owner creation returned unexpected ports');}
          if(result.value!==true)throw new DOMException('Actor owner was not created','InvalidStateError');
        });resource.uis.set(id,creating);
        creating.catch(()=>{if(resource.uis.get(id)===creating)resource.uis.delete(id);});
      }
      await creating;if(!current())throw unavailable();
      const result=await ui.channel.request('connect',{actor:resource.id});
      if(!current()){for(const port of result.ports)port.close();throw unavailable();}
      if(result.ports.length!==1||!Number.isSafeInteger(result.value?.client)||result.value.client<1){for(const port of result.ports)port.close();throw new TypeError('The UI did not return one native actor port');}
      return {id:resource.id,profile:resource.profile,client:result.value.client,port:result.ports[0],created:acquired.created};
    })();
    let success=false;
    try{const result=await Promise.race([connecting,membership.promise]);success=true;usage.connected=true;return result;}
    finally{
      usage.pending--;
      if(!success&&!usage.pending&&!usage.connected&&current()){
        this.registry.releaseOwner(owner,resource.id);resource.users.delete(owner);
        if(!this.registry.owners.has(owner))ui.owners.delete(owner);
      }
    }
  }
  release(id,document){
    const ui=this.uis.get(id);if(!ui)return 0;
    const owner=this.owner(ui,document);ui.owners.delete(owner);for(const resource of this.resources)resource.users.delete(owner);return this.registry.releaseOwner(owner);
  }
  closeWorker(id){return this.registry.close(id);}
  close(){
    if(this.closed)return;this.closed=true;
    for(const id of [...this.registry.ids.keys()])this.registry.close(id);
    for(const ui of [...this.uis.values()])ui.channel.close();
  }
}
