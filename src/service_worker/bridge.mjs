// Owns a worker's control requests independently of the visible document.
// Response headers, background event work and body readers finish separately.
export class ServiceWorkerBridge{
  constructor({post,terminate,command,timeout=30000}){
    Object.assign(this,{post,terminate,command,timeout});this.jobs=new Map();this.closed=false;
    this.startup=this.deferred();this.ready=this.startup.promise;
  }
  deferred(){
    let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});promise.catch(()=>{});
    const timer=setTimeout(()=>this.close(new DOMException('Service worker operation timed out','TimeoutError')),this.timeout);
    return {promise,resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}};
  }
  send(packet,transfer){
    if(this.closed)throw new DOMException('Service worker was terminated','InvalidStateError');
    this.post(packet,transfer);
  }
  dispatch(packet){
    if(this.closed)throw new DOMException('Service worker was terminated','InvalidStateError');
    if(this.jobs.has(packet.id))throw new TypeError('Duplicate service worker event ID');
    const job={result:this.deferred(),lifetime:this.deferred()};this.jobs.set(packet.id,job);
    try{this.send({...packet,type:'dispatch'},packet.ports||[]);}catch(error){this.jobs.delete(packet.id);job.result.reject(error);job.lifetime.reject(error);}
    return job.result.promise;
  }
  job(id){const job=this.jobs.get(id);if(!job)throw new TypeError('Unknown service worker event');return job;}
  wait(id){return this.job(id).lifetime.promise;}
  read(id){
    const job=this.job(id);if(job.read)throw new DOMException('A body read is already pending','InvalidStateError');
    const pending=job.read=this.deferred();
    try{this.send({type:'read',id});}catch(error){job.read=null;pending.reject(error);}
    return pending.promise;
  }
  cancel(id,reason){
    const job=this.job(id);if(job.cancel)return job.cancel.promise;
    const pending=job.cancel=this.deferred();
    try{this.send({type:'cancel',id,reason});}catch(error){job.cancel=null;pending.reject(error);}
    return pending.promise;
  }
  abort(id,reason){this.job(id);this.send({type:'abort',id,reason});}
  handled(id,error){this.job(id);this.send({type:'handled',id,...(error?{error:{name:error.name||'Error',message:error.message||String(error)}}:{})});}
  scripts(){
    if(this.scriptRequest)return this.scriptRequest.promise;
    const pending=this.scriptRequest=this.deferred();
    try{this.send({type:'scripts'});}catch(error){this.scriptRequest=null;pending.reject(error);}
    return pending.promise;
  }
  release(id){
    const job=this.jobs.get(id);if(!job)return;
    const error=new DOMException('Service worker event was released','AbortError');
    for(const pending of [job.result,job.lifetime,job.read,job.cancel])pending?.reject(error);
    this.jobs.delete(id);
  }
  accept(packet){
    if(this.closed||!packet||typeof packet!=='object')return;
    if(packet.type==='ready'){this.startup.resolve();return;}
    if(packet.type==='scripts'){this.scriptRequest?.resolve(packet.scripts);this.scriptRequest=null;return;}
    if(packet.type==='command'){
      Promise.resolve().then(()=>{
        if(!this.command)throw new DOMException('Service worker owner command is unavailable','NotSupportedError');
        return this.command(packet.method,packet.args,packet.ports||[]);
      }).then(value=>{if(!this.closed)this.send({type:'command-result',id:packet.id,value});},error=>{
        if(!this.closed)this.send({type:'command-result',id:packet.id,error:{name:error?.name||'Error',message:error?.message||String(error)}});
      }).catch(error=>this.close(error));return;
    }
    const job=this.jobs.get(packet.id);if(!job)return;
    const error=packet.error&&Object.assign(new Error(packet.error.message),{name:packet.error.name,...(packet.error.stack?{stack:packet.error.stack}:{})});
    if(packet.type==='error'){
      const pending=job.read||job.cancel||job.result;job.read=null;job.cancel=null;pending.reject(error||new TypeError('Service worker request failed'));return;
    }
    if(packet.type==='lifetime'){if(error)job.lifetime.reject(error);else job.lifetime.resolve();return;}
    if(packet.type==='chunk'){const pending=job.read;job.read=null;pending?.resolve({done:packet.done,value:packet.value});return;}
    if(packet.type==='canceled'){job.cancel?.resolve();job.cancel=null;return;}
    if(['response','fallback','dispatched'].includes(packet.type))job.result.resolve(packet);
  }
  close(reason=new DOMException('Service worker was terminated','AbortError')){
    if(this.closed)return;this.closed=true;this.startup.reject(reason);
    this.scriptRequest?.reject(reason);this.scriptRequest=null;
    for(const job of this.jobs.values())for(const pending of [job.result,job.lifetime,job.read,job.cancel])pending?.reject(reason);
    this.jobs.clear();this.terminate();
  }
}
