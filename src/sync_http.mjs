const {load,store,notify,wait}=Atomics;
const Bytes=Uint8Array,Words=Int32Array,Exception=DOMException,Controller=AbortController;
const now=performance.now.bind(performance);
const frameBytes=65536,headerBytes=16;
const encoder=new TextEncoder(),decoder=new TextDecoder();
const stringify=JSON.stringify,parse=JSON.parse;
const networkError=message=>new Exception(message||'Synchronous request failed','NetworkError');

// Only a worker blocks. Its owning frame continues ordinary asynchronous relay
// requests and acknowledges each bounded shared-memory chunk over the control port.
export function create_sync_http_client({post,SharedBuffer=globalThis.SharedArrayBuffer}){
  let sequence=0;
  return function request(url,options,timeout=0){
    const buffer=new SharedBuffer(headerBytes+frameBytes),header=new Words(buffer,0,4),payload=new Bytes(buffer,headerBytes),id=++sequence;
    const metadata=[],chunks=[];let length=0;const started=now();
    const cancel=()=>{store(header,2,1);post({type:'sync-http-cancel',id});};
    try{
      post({type:'sync-http-request',id,url,options,buffer});
      for(;;){
        while(load(header,0)===0){
          if(load(header,2))throw networkError('Synchronous request was stopped');
          const remaining=timeout?Math.max(0,timeout-(now()-started)):Infinity;
          if(wait(header,0,0,remaining)==='timed-out'&&load(header,0)===0)throw new Exception('Synchronous request timed out','TimeoutError');
        }
        if(load(header,2))throw networkError('Synchronous request was stopped');
        const kind=load(header,0),size=load(header,1);
        if(size<0||size>payload.length)throw networkError('Invalid synchronous response chunk');
        const bytes=payload.slice(0,size);store(header,0,0);post({type:'sync-http-ack',id});
        if(kind===1)metadata.push(bytes);
        else if(kind===2){chunks.push(bytes);length+=size;}
        else if(kind===3){
          const meta=join(metadata),result=parse(decoder.decode(meta));
          return {...result,bytes:join(chunks,length)};
        }else if(kind===4){const error=parse(decoder.decode(bytes));throw networkError(error.message);}
        else throw networkError('Invalid synchronous response state');
      }
    }catch(error){cancel();throw error;}
  };
}

function join(chunks,length=chunks.reduce((sum,chunk)=>sum+chunk.byteLength,0)){
  const bytes=new Bytes(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}

export function create_sync_http_server({fetch,SharedBuffer=globalThis.SharedArrayBuffer}){
  const entries=new Map(),size=SharedBuffer&&Object.getOwnPropertyDescriptor(SharedBuffer.prototype,'byteLength').get;let closed=false;
  async function send(entry,kind,bytes=new Bytes()){
    for(let offset=0;offset<bytes.length||offset===0;offset+=frameBytes){
      entry.controller.signal.throwIfAborted();if(load(entry.header,2))throw networkError('Synchronous client stopped reading');
      const part=bytes.subarray(offset,offset+frameBytes);
      await new Promise((resolve,reject)=>{
        entry.resolve=resolve;entry.reject=reject;
        entry.payload.set(part);store(entry.header,1,part.length);store(entry.header,0,kind);notify(entry.header,0);
      });
    }
  }
  async function run(entry,packet){
    let reader,complete=false;
    try{
      const response=await fetch(packet.url,packet.options,entry.controller.signal);
      if(entry.controller.signal.aborted){await response.body?.cancel();return;}
      if(!response.status)throw networkError();
      reader=entry.reader=response.body?.getReader();
      await send(entry,1,encoder.encode(stringify({status:response.status,statusText:response.statusText,url:response.url||packet.url,headers:[...response.headers]})));
      while(reader){const item=await reader.read();if(item.done)break;await send(entry,2,item.value);}
      complete=true;await send(entry,3);
    }catch(error){
      if(!entry.controller.signal.aborted&&!load(entry.header,2)){
        try{await send(entry,4,encoder.encode(stringify({message:String(error?.message||error).slice(0,8192)})));}catch{}
      }
    }finally{
      if(!complete)await reader?.cancel().catch(()=>{});reader?.releaseLock();
      if(entries.get(entry.id)===entry)entries.delete(entry.id);
    }
  }
  return {
    receive(packet){
      if(!packet||!['sync-http-request','sync-http-ack','sync-http-cancel'].includes(packet.type))return false;
      if(packet.type==='sync-http-ack'){const entry=entries.get(packet.id);if(entry){const resolve=entry.resolve;entry.resolve=entry.reject=null;resolve?.();}return true;}
      if(packet.type==='sync-http-cancel'){const entry=entries.get(packet.id);if(entry){entries.delete(packet.id);entry.controller.abort(networkError('Synchronous client cancelled'));}return true;}
      if(closed||entries.size||!Number.isSafeInteger(packet.id)||packet.id<=0||typeof packet.url!=='string'||!packet.options)return true;
      try{if(!size||Reflect.apply(size,packet.buffer,[])!==headerBytes+frameBytes)return true;}catch{return true;}
      const entry={id:packet.id,controller:new Controller(),header:new Words(packet.buffer,0,4),payload:new Bytes(packet.buffer,headerBytes)};
      entry.controller.signal.addEventListener('abort',()=>{entry.reject?.(entry.controller.signal.reason);entry.resolve=entry.reject=null;void entry.reader?.cancel(entry.controller.signal.reason).catch(()=>{});},{once:true});
      entries.set(entry.id,entry);void run(entry,packet);return true;
    },
    close(reason=networkError('Worker was terminated')){closed=true;for(const entry of entries.values()){store(entry.header,2,1);notify(entry.header,0);entry.controller.abort(reason);}entries.clear();},
    get size(){return entries.size;}
  };
}
