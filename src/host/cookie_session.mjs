import {create_bootstrap_nonce} from '../bootstrap.mjs';

const prefix='sandstone.cookie-session.v1:';

// A native lock advertises a host only while it can answer snapshot requests.
// Watching that lock also settles startup if the owner closes before replying.
export class CookieSession {
  constructor({Channel,locks,snapshot,receive}){
    Object.assign(this,{locks,snapshot,receive});
    this.id=create_bootstrap_nonce();this.waiting=new Map();
    this.controller=new AbortController();
    this.ready=new Promise(resolve=>this.finishReady=resolve);
    this.hold=new Promise(resolve=>this.release=resolve);
    try{
      this.channel=new Channel(prefix);
      this.channel.onmessage=event=>this.message(event.data);
      this.previous=JSON.stringify(snapshot());
      this.lifetime=locks.request(prefix+this.id,{signal:this.controller.signal},async()=>{
        const {held}=await locks.query();
        const peers=held.filter(lock=>lock.name.startsWith(prefix)&&lock.name!==prefix+this.id);
        await Promise.all(peers.map(lock=>this.synchronize(lock.name.slice(prefix.length))));
        this.finishReady();await this.hold;
      });
      this.lifetime.catch(()=>this.close());
    }catch{this.close();}
  }
  post(value){try{this.channel?.postMessage({...value,from:this.id});}catch{}}
  synchronize(id){
    if(this.closed)return;
    return new Promise(resolve=>{
      const controller=new AbortController();
      const finish=()=>{
        if(this.waiting.get(id)?.finish!==finish)return;
        this.waiting.delete(id);controller.abort();resolve();
      };
      this.waiting.set(id,{finish});
      this.locks.request(prefix+id,{signal:controller.signal},finish).catch(finish);
      this.post({type:'request',target:id});
    });
  }
  message(message){
    if(this.closed||!message||typeof message.from!=='string'||message.from===this.id||message.target!==undefined&&message.target!==this.id)return;
    if(message.type==='request'){
      try{this.post({type:'snapshot',target:message.from,entries:this.snapshot()});}catch{}
    }else if(message.type==='snapshot'&&Array.isArray(message.entries)){
      try{this.receive(message.entries);}catch{}finally{this.waiting.get(message.from)?.finish();}
    }
  }
  changed(){
    if(this.closed)return;
    const entries=this.snapshot(),next=JSON.stringify(entries);
    if(next===this.previous)return;
    this.previous=next;this.post({type:'snapshot',entries});
  }
  close(){
    if(this.closed)return;this.closed=true;
    for(const waiter of [...this.waiting.values()])waiter.finish();
    this.controller.abort();this.release();this.channel?.close();this.finishReady();
  }
}
