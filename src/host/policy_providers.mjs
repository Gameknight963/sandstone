import {create_bootstrap_nonce} from '../bootstrap.mjs';

const leasePrefix='sandstone.policy-provider.v1:';
const unavailable=()=>new DOMException('Policy provider is unavailable','InvalidStateError');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const errorValue=error=>({name:String(error?.name||'Error'),message:String(error?.message||error)});

// Both ends are trusted hosts. Never attach an authored renderer's RPC port:
// policy results include HttpOnly cookies and private storage metadata.
export function serve_policy_channel(port,handle,{authority=()=>undefined}={}){
  if(!(port instanceof MessagePort)||typeof handle!=='function'||typeof authority!=='function')throw new TypeError('A private policy port and handler are required');
  const active=new Map();let closed=false;
  const stop=()=>{
    if(closed)return;closed=true;port.removeEventListener('message',receive);
    for(const controller of active.values())controller.abort();active.clear();port.close();
  };
  const receive=async event=>{
    const message=event.data;
    if(message?.type==='closed'){stop();return;}
    if(message?.type==='cancel'){active.get(message.id)?.abort();active.delete(message.id);return;}
    if(closed||message?.type!=='request'||!Number.isSafeInteger(message.id)||active.has(message.id))return;
    const controller=new AbortController();active.set(message.id,controller);
    let reply;
    try{reply={type:'reply',id:message.id,ok:true,value:await handle(message.message,{signal:controller.signal})};}
    catch(error){reply={type:'reply',id:message.id,ok:false,error:errorValue(error)};}
    if(closed||active.get(message.id)!==controller)return;
    active.delete(message.id);
    try{reply.authority=authority();port.postMessage(reply);}
    catch(error){try{port.postMessage({type:'reply',id:message.id,ok:false,error:errorValue(error)});}catch{}}
  };
  port.addEventListener('message',receive);port.start();
  return {close(){if(!closed)try{port.postMessage({type:'closed'});}catch{}stop();}};
}

class PolicyChannel{
  constructor(port,{authority,onClose,onChange}){
    this.port=port;this.authority=authority;this.onClose=onClose;this.onChange=onChange;this.pending=new Map();this.sequence=0;
    this.receive=event=>{
      const reply=event.data;
      if(reply?.type==='closed'){this.close();return;}
      if(reply?.type!=='reply')return;
      const call=this.pending.get(reply.id);if(!call)return;
      if(typeof reply.authority==='string'&&reply.authority!==this.authority){this.authority=reply.authority;this.onChange();}
      this.pending.delete(reply.id);call.clean();
      if(reply.ok===true)call.resolve(reply.value);
      else{const error=new Error(reply.error?.message||'Policy request failed');error.name=reply.error?.name||'Error';call.reject(error);}
    };
    port.addEventListener('message',this.receive);port.start();
  }
  request(message,{signal}={}){
    signal?.throwIfAborted();if(this.closed)return Promise.reject(unavailable());
    return new Promise((resolve,reject)=>{
      const id=++this.sequence;
      const abort=()=>{
        if(!this.pending.delete(id))return;clean();reject(signal.reason);
        try{this.port.postMessage({type:'cancel',id});}catch{}
      };
      const clean=()=>signal?.removeEventListener('abort',abort);
      this.pending.set(id,{resolve,reject,clean});signal?.addEventListener('abort',abort,{once:true});
      try{this.port.postMessage({type:'request',id,message});}
      catch(error){this.pending.delete(id);clean();reject(error);}
    });
  }
  close(){
    if(this.closed)return;this.closed=true;this.port.removeEventListener('message',this.receive);
    try{this.port.postMessage({type:'closed'});}catch{}this.port.close();
    for(const call of this.pending.values()){call.clean();call.reject(unavailable());}this.pending.clear();this.onClose();
  }
}

// A native lock is released when its actual Window dies, including abrupt
// closure where an unload notification or a MessagePort reply never arrives.
export async function create_policy_provider(handle,{authority=()=>undefined,locks=globalThis.navigator?.locks}={}){
  if(typeof handle!=='function'||typeof authority!=='function')throw new TypeError('A policy handler and authority getter are required');
  if(typeof locks?.request!=='function')throw new DOMException('Policy provider leases require Web Locks','NotSupportedError');
  const controller=new AbortController(),ready=deferred(),hold=deferred(),lease=leasePrefix+create_bootstrap_nonce();
  const lifetime=locks.request(lease,{signal:controller.signal},async()=>{ready.resolve();await hold.promise;});
  lifetime.catch(ready.reject);
  let channel,server;
  try{
    await ready.promise;
    channel=new MessageChannel();server=serve_policy_channel(channel.port1,handle,{authority});let closed=false;
    return {port:channel.port2,lease,authority:authority(),close(){if(closed)return;closed=true;server.close();hold.resolve();controller.abort();}};
  }catch(error){server?.close();channel?.port2.close();hold.resolve();controller.abort();throw error;}
}

// The private protocol must be replay-safe. Cookie mutations carry prepared
// write tokens; arbitrary side-effecting RPCs do not belong in this pool.
export class PolicyProviders{
  constructor({locks=globalThis.navigator?.locks}={}){this.locks=locks;this.providers=new Set();this.waiters=new Set();}
  wake(){for(const waiter of [...this.waiters])waiter();}
  add(port,{authority,lease,signal}={}){
    if(this.closed)throw unavailable();
    if(!(port instanceof MessagePort)||authority!==undefined&&typeof authority!=='string'||signal&&(typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'))throw new TypeError('Invalid policy provider');
    if(!lease&&!signal)throw new TypeError('A provider lifetime is required');
    if(lease&&(typeof lease!=='string'||!lease.startsWith(leasePrefix)||typeof this.locks?.request!=='function'))throw new TypeError('Invalid provider lease');
    let unwatch=()=>{};
    const channel=new PolicyChannel(port,{authority,onChange:()=>this.wake(),onClose:()=>{unwatch();this.providers.delete(channel);this.wake();}});
    this.providers.add(channel);
    const abort=()=>channel.close();signal?.addEventListener('abort',abort,{once:true});
    let watch;
    if(lease){
      watch=new AbortController();
      try{this.locks.request(lease,{signal:watch.signal},abort).catch(()=>{if(!watch.signal.aborted)abort();});}
      catch(error){channel.close();watch.abort();signal?.removeEventListener('abort',abort);throw error;}
    }
    unwatch=()=>{watch?.abort();signal?.removeEventListener('abort',abort);};
    if(signal?.aborted||channel.closed){channel.close();unwatch();}
    this.wake();return {close:()=>channel.close()};
  }
  async request(message,{signal}={}){
    signal?.throwIfAborted();message=structuredClone(message);
    const authority=message.options?.cookieAuthority??message.context?.cookieAuthority??message.options?.cookieWrite?.authority;
    for(;;){
      signal?.throwIfAborted();if(this.closed)throw unavailable();
      const provider=[...this.providers].find(provider=>!provider.closed&&(authority===undefined||provider.authority===authority));
      if(provider){
        try{
          const value=await provider.request(message,{signal});
          if(authority!==undefined&&provider.authority!==authority)continue;
          return value;
        }catch(error){if(!provider.closed&&(authority===undefined||provider.authority===authority))throw error;continue;}
      }
      if(this.providers.size&&authority!==undefined)throw new DOMException('No matching cookie authority','InvalidStateError');
      await new Promise((resolve,reject)=>{
        const finish=()=>{this.waiters.delete(wake);signal?.removeEventListener('abort',abort);};
        const wake=()=>{finish();resolve();},abort=()=>{finish();reject(signal.reason);};
        this.waiters.add(wake);signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted)abort();
      });
    }
  }
  close(){if(this.closed)return;this.closed=true;for(const provider of [...this.providers])provider.close();this.wake();}
}
