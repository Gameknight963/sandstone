const NativeResponse=globalThis.Response;
const NativeHeaders=globalThis.Headers;
const clone=NativeResponse?.prototype.clone;
const fields=['url','type','redirected','request_referrer','request_cross_origin'];
const key=(url,options,owner)=>JSON.stringify([owner,url,options.destination||'',options.mode||'no-cors',options.credentials||'include']);

// Preloads belong to one document and are consumed by a matching resource
// request even when HTTP caching is disabled. Oversized hints still complete;
// only their optional reuse is dropped when the collection budget is exhausted.
export class ResourcePreloads{
  constructor({maxBytes=16*1024*1024,maxEntries=64}={}){Object.assign(this,{maxBytes,maxEntries});this.entries=new Map();this.bytes=0;}
  release(entry){this.bytes-=entry.size;entry.size=0;}
  load(url,options,owner,fetch){
    const id=key(url,options,owner),previous=this.entries.get(id);if(previous)return previous.ready;
    while(this.entries.size>=this.maxEntries){const [old,value]=this.entries.entries().next().value;this.entries.delete(old);value.cached=false;this.release(value);}
    const entry={cached:true,size:0};this.entries.set(id,entry);
    entry.ready=(async()=>{
      const response=await fetch(),reader=response.body?.getReader(),chunks=[];
      try{
        if(reader)for(;;){const chunk=await reader.read();if(chunk.done)break;
          if(entry.cached&&this.bytes+chunk.value.byteLength<=this.maxBytes){const copy=chunk.value.slice();chunks.push(copy);entry.size+=copy.byteLength;this.bytes+=copy.byteLength;}
          else{entry.cached=false;chunks.length=0;this.release(entry);}
        }
        const bytes=entry.cached?new Uint8Array(entry.size):null;let offset=0;if(bytes)for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
        return {status:response.status,statusText:response.statusText,headers:[...response.headers],metadata:Object.fromEntries(fields.filter(field=>response[field]!==undefined).map(field=>[field,response[field]])),bytes};
      }catch(error){await reader?.cancel(error).catch(()=>{});throw error;}
    })();
    entry.ready.catch(()=>{if(this.entries.get(id)===entry)this.entries.delete(id);entry.cached=false;this.release(entry);});
    return entry.ready;
  }
  consume(url,options,owner){
    if(options.method&&options.method.toUpperCase()!=='GET'||options.keepalive||options.body!=null||options.headers&&[...new NativeHeaders(options.headers)].length)return;
    const id=key(url,options,owner),entry=this.entries.get(id);if(!entry)return;
    this.entries.delete(id);
    return entry.ready.then(snapshot=>{
      this.release(entry);if(!snapshot.bytes)return;
      const restore=body=>{
        const response=new NativeResponse([204,205,304].includes(snapshot.status)?null:body,{status:snapshot.status,statusText:snapshot.statusText,headers:snapshot.headers});
        for(const [field,value] of Object.entries(snapshot.metadata))Object.defineProperty(response,field,{value,configurable:true});
        Object.defineProperty(response,'clone',{value:()=>restore(clone.call(response).body)});return response;
      };
      return restore(snapshot.bytes);
    });
  }
}
