import {getPublicSuffix} from 'tough-cookie';

function ordered(entry,name,run,failed){
  let result;
  try{result=entry[name]?entry[name].then(run):run();}catch(error){failed(error);return;}
  if(!result||typeof result.then!=='function')return result;
  const pending=Promise.resolve(result).catch(error=>{try{failed(error);}catch{}});entry[name]=pending;
  pending.then(()=>{if(entry[name]===pending)delete entry[name];});return pending;
}

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
    entry.active=()=>{if(this.channels.has(entry)&&!context.retired)return true;this.close(entry);return false;};
    entry.failed=()=>{if(entry.active())try{port.postMessage({type:'messageerror',data:null,origin:entry.origin});}catch{this.close(entry);}};
    entry.deliver=(type,data)=>ordered(entry,'receiving',()=>{
      if(!entry.active())return;
      const encoded=this.encode(data),post=value=>{if(entry.active())port.postMessage({type,data:value,origin:entry.origin});};
      return encoded&&typeof encoded.then==='function'?Promise.resolve(encoded).then(post):post(encoded);
    },entry.failed);
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
    return ordered(entry,'sending',()=>{
      if(!entry.active())return;
      const decoded=this.decode(value),post=data=>{
        if(!entry.active())return;
        if(entry.channel)entry.channel.postMessage(data);
        else for(const peer of this.channels){
          if(peer===entry||peer.key!==entry.key||peer.context.retired)continue;
          peer.deliver('message',structuredClone(data));
        }
      };
      return decoded&&typeof decoded.then==='function'?Promise.resolve(decoded).then(post):post(decoded);
    },()=>entry.deliver('messageerror',null));
  }
  close(entry){this.channels.delete(entry);entry.channel?.close();entry.port.close();}
  disconnect(frame){for(const entry of this.channels)if(entry.context.frame===frame)this.close(entry);}
}
