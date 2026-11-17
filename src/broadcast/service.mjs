import {getPublicSuffix} from 'tough-cookie';

export class BroadcastService {
  constructor({contexts,Channel=globalThis.BroadcastChannel,encode=value=>value,decode=value=>value}){
    Object.assign(this,{contexts,Channel,encode,decode});this.channels=new Set();
  }
  open(token,id,name,port){
    const context=this.contexts().get(token);
    if(!context||context.retired)throw new DOMException('Broadcast document is unavailable','InvalidStateError');
    const info=context.context,origin=info.broadcast_origin||new URL(info.url).origin,top=new URL(info.top_url||info.url);
    const site=top.protocol+'//'+(getPublicSuffix(top.hostname,{ignoreError:true})||top.hostname);
    const key=JSON.stringify(['sandstone.broadcast.v1',site,origin,name]);
    const entry={token,id,context,port,key,origin:origin.startsWith('opaque:')?'null':origin};
    try{if(this.Channel)entry.channel=new this.Channel(key);}catch{}
    this.channels.add(entry);
    entry.deliver=(type,data)=>{
      if(!this.channels.has(entry)||context.retired){this.close(entry);return;}
      port.postMessage({type,data:this.encode(data),origin:entry.origin});
    };
    if(entry.channel){
      entry.channel.onmessage=event=>entry.deliver('message',event.data);
      entry.channel.onmessageerror=()=>entry.deliver('messageerror',null);
    }
    port.start();
  }
  command(token,id,type,value){
    const entry=[...this.channels].find(entry=>entry.token===token&&entry.id===id);
    if(!entry)return;
    if(type==='close'){this.close(entry);return;}
    if(type!=='post'||entry.context.retired){if(entry.context.retired)this.close(entry);return;}
    try{
      const data=this.decode(value);
      if(entry.channel)entry.channel.postMessage(data);
      else for(const peer of this.channels){
        if(peer===entry||peer.key!==entry.key||peer.context.retired)continue;
        peer.port.postMessage({type:'message',data:this.encode(structuredClone(data)),origin:entry.origin});
      }
    }catch{entry.deliver('messageerror',null);}
  }
  close(entry){this.channels.delete(entry);entry.channel?.close();entry.port.close();}
  disconnect(frame){for(const entry of this.channels)if(entry.context.frame===frame)this.close(entry);}
}
