// Insecure hosting does not expose native Web Locks. Keep the same scheduler
// for frames/workers sharing this host, without requiring persistent storage.
export class MemoryLockManager {
  constructor(){this.entries=new Set();}
  request(name,options,callback){
    const {mode='exclusive',signal,ifAvailable=false,steal=false}=options;
    return new Promise((resolve,reject)=>{
      const entry={name,mode,callback,resolve,reject,status:'pending',signal};
      entry.abort=()=>{if(entry.status==='pending')this.finish(entry,false,signal.reason);};
      if(signal?.aborted){reject(signal.reason);return;}
      signal?.addEventListener('abort',entry.abort,{once:true});
      if(steal){
        for(const held of [...this.entries])if(held.name===name&&held.status==='held')this.remove(held,false,new DOMException('The lock was stolen','AbortError'));
        this.entries=new Set([entry,...this.entries]);
      }else{
        const available=![...this.entries].some(other=>other.name===name&&(other.status==='pending'||mode==='exclusive'||other.mode==='exclusive'));
        if(ifAvailable&&!available){signal?.removeEventListener('abort',entry.abort);Promise.resolve().then(()=>callback(null)).then(resolve,reject);return;}
        this.entries.add(entry);
      }
      this.drain(name);
    });
  }
  remove(entry,success,value){
    this.entries.delete(entry);entry.signal?.removeEventListener('abort',entry.abort);entry.status='done';
    (success?entry.resolve:entry.reject)(value);
  }
  finish(entry,success,value){if(entry.status==='done')return;this.remove(entry,success,value);this.drain(entry.name);}
  drain(name){
    for(const entry of this.entries){
      if(entry.name!==name||entry.status!=='pending')continue;
      if([...this.entries].some(other=>other!==entry&&other.name===name&&other.status==='held'&&(entry.mode==='exclusive'||other.mode==='exclusive')))break;
      entry.status='held';entry.signal?.removeEventListener('abort',entry.abort);
      Promise.resolve().then(()=>entry.status==='held'?entry.callback({name,mode:entry.mode}):undefined).then(value=>this.finish(entry,true,value),error=>this.finish(entry,false,error));
    }
  }
  async query(){
    const snapshot={held:[],pending:[]};
    for(const entry of this.entries)snapshot[entry.status==='held'?'held':'pending'].push({name:entry.name,mode:entry.mode,clientId:'memory-host'});
    return snapshot;
  }
}
