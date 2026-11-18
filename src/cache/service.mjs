import {MemoryCacheStorage,request_data,restore_request,stored_response,response_data,validate_put,matches} from './storage.mjs';

const prefix='sandstone:cache:';
const physical=(origin,name)=>prefix+JSON.stringify([origin,name]);
const native_request=data=>restore_request({url:data.url,method:data.method,headers:data.headers});
function identity(name){try{if(name.startsWith(prefix)){const value=JSON.parse(name.slice(prefix.length));if(value.length===2&&new URL(value[0]).origin===value[0])return {origin:value[0],name:value[1]};}}catch{}return null;}

export class CacheService {
  constructor(storage,{locks,onCatalog=()=>{}}={}){
    this.storage=storage;this.locks=locks;this.onCatalog=onCatalog;this.persistent=!!storage;
    this.handles=new Map();this.next=0;this.tails=new Map();this.ready=this.probe();
  }
  async probe(){
    if(this.storage){try{await this.storage.keys();return;}catch{}}
    this.storage=new MemoryCacheStorage();this.persistent=false;
  }
  async lock(origin,action){
    await this.ready;
    const previous=this.tails.get(origin)||Promise.resolve();
    const task=previous.catch(()=>{}).then(async()=>{
      if(!this.locks)return action();
      let started=false;
      try{return await this.locks.request(physical(origin,'lock'),()=>{started=true;return action();});}
      catch(error){if(started||error.name!=='SecurityError')throw error;this.locks=null;return action();}
    });
    this.tails.set(origin,task);try{return await task;}finally{if(this.tails.get(origin)===task)this.tails.delete(origin);}
  }
  async catalog(){await this.ready;const entries=(await this.storage.keys()).map(identity).filter(Boolean);this.onCatalog(entries);return entries;}
  disconnect(client){for(const [id,handle] of this.handles)if(handle.client===client)this.handles.delete(id);}
  async clear(hostname){
    const origins=new Set((await this.catalog()).filter(item=>new URL(item.origin).hostname===hostname).map(item=>item.origin));
    for(const handle of this.handles.values())if(new URL(handle.origin).hostname===hostname)origins.add(handle.origin);
    for(const origin of origins)await this.lock(origin,async()=>{
      for(const name of await this.storage.keys())if(identity(name)?.origin===origin)await this.storage.delete(name);
      for(const [id,handle] of this.handles)if(handle.origin===origin)this.handles.delete(id);
    });
    await this.catalog();
  }
  async command(client,origin,command){
    if(!origin||origin==='null'||!['http:','https:'].includes(new URL(origin).protocol))throw new DOMException('Cache origin is unavailable','SecurityError');
    return this.lock(origin,async()=>{
      const {method}=command;
      if(!command.cache){
        const names=()=>this.storage.keys().then(names=>names.filter(name=>identity(name)?.origin===origin));
        if(method==='keys')return (await names()).map(name=>identity(name).name);
        if(method==='has')return (await names()).includes(physical(origin,command.name));
        if(method==='delete'){const result=await this.storage.delete(physical(origin,command.name));await this.catalog();return result;}
        if(method==='open'){
          const cache=await this.storage.open(physical(origin,command.name)),id=++this.next;
          this.handles.set(id,{client,origin,cache});await this.catalog();return id;
        }
        if(method==='match'){
          for(const name of await names()){
            if(command.options?.cacheName!==undefined&&identity(name).name!==command.options.cacheName)continue;
            const result=await (await this.storage.open(name)).match(native_request(command.request),command.options);
            if(result)return response_data(result);
          }
          return undefined;
        }
        throw new TypeError('Unknown CacheStorage operation');
      }
      const handle=this.handles.get(command.cache);
      if(!handle||handle.client!==client||handle.origin!==origin)throw new DOMException('Cache handle is unavailable','InvalidStateError');
      const cache=handle.cache,request=command.request?native_request(command.request):undefined;
      if(method==='match')return response_data(await cache.match(request,command.options));
      if(method==='matchAll')return Promise.all((await cache.matchAll(request,command.options)).map(response_data));
      if(method==='keys')return (await cache.keys(request,command.options)).map(request_data);
      if(method==='delete')return cache.delete(request,command.options);
      if(method==='put'){
        validate_put(command.request,{...command.response.items,headers:command.response.headers});
        await cache.put(request,stored_response(command.response));return;
      }
      if(method==='batch'){
        const added=[];
        for(const item of command.entries){
          validate_put(item.request,{...item.response.items,headers:item.response.headers});
          if(added.some(entry=>matches(item.request,{request:entry.request,response:{headers:entry.response.headers}})))throw new DOMException('Duplicate requests in cache batch','InvalidStateError');
          added.push(item);
        }
        if(!added.length)return;
        if(added.length===1){await cache.put(native_request(added[0].request),stored_response(added[0].response));return;}
        // Lock all readers/writers while committing. Retain native response
        // streams for rollback, so rejected batches never leave partial data.
        const keys=await cache.keys(),responses=await cache.matchAll();
        try{for(const item of added)await cache.put(native_request(item.request),stored_response(item.response));}
        catch(error){
          for(const key of await cache.keys())await cache.delete(key,{ignoreVary:true});
          for(let index=0;index<keys.length;index++)await cache.put(keys[index],responses[index]);
          throw error;
        }
        return;
      }
      throw new TypeError('Unknown Cache operation');
    });
  }
}
