import {request_data,restore_cached_request,validate_put} from './storage.mjs';
import {response_metadata,remember_response} from '../response_metadata.mjs';

const NativeResponse=globalThis.Response;
const NativeRequest=globalThis.Request;
const NativeAbortController=globalThis.AbortController;
const response_body=Object.getOwnPropertyDescriptor(NativeResponse.prototype,'body').get;
const response_used=Object.getOwnPropertyDescriptor(NativeResponse.prototype,'bodyUsed').get;
const read_body=NativeResponse.prototype.blob;
function required(args,count){if(args.length<count)throw new TypeError('Not enough arguments');}
function query_options(value={},storage=false){
  if(value!==null&&!['object','function'].includes(typeof value))throw new TypeError('Cache options must be an object');
  return {ignoreSearch:!!value?.ignoreSearch,ignoreMethod:!!value?.ignoreMethod,ignoreVary:!!value?.ignoreVary,...(storage&&value?.cacheName!==undefined?{cacheName:`${value.cacheName}`}:{})};
}
async function snapshot(response){
  const body=response_body.call(response);
  if(response_used.call(response)||body?.locked)throw new TypeError('Response body is already used or locked');
  const {headers,...items}=response_metadata(response);
  return {headers:[...headers],items,body:body===null?null:await read_body.call(response)};
}
function response_from(data){
  if(!data)return undefined;
  const response=data.items.status===0?NativeResponse.error():new NativeResponse(data.body,{status:data.items.status,statusText:data.items.statusText,headers:data.headers});
  for(const key of ['url','type','redirected'])Object.defineProperty(response,key,{value:data.items[key]});
  const clone=response.clone.bind(response);Object.defineProperty(response,'clone',{value:()=>response_from({...data,body:clone().body})});
  return remember_response(response,data.items);
}

export function create_cache_api({command,fetch,Request:RequestClass}){
  const caches=new WeakMap(),managers=new WeakSet(),token={};
  const request=input=>request_data(input instanceof NativeRequest?input:new RequestClass(input));
  const cache_state=value=>{const state=caches.get(value);if(!state)throw new TypeError('Illegal Cache receiver');return state;};
  const manager=value=>{if(!managers.has(value))throw new TypeError('Illegal CacheStorage receiver');};
  const call=(value,method,request,options)=>command({cache:cache_state(value),method,request,options});
  async function add_all(value,inputs){
    const id=cache_state(value);
    if(inputs===null||!['object','function'].includes(typeof inputs)||typeof inputs[Symbol.iterator]!=='function')throw new TypeError('Cache requests must be a sequence');
    const requests=Array.from(inputs,input=>input instanceof NativeRequest?input:new RequestClass(input));
    for(const input of requests)validate_put(request_data(input),{status:200,headers:[]});
    const abort=new NativeAbortController(),cleanup=[];
    const signals=requests.map(input=>{
      const controller=new NativeAbortController();
      for(const source of [input.signal,abort.signal]){
        const cancel=()=>controller.abort(source.reason);
        if(source.aborted)cancel();else{source.addEventListener('abort',cancel,{once:true});cleanup.push(()=>source.removeEventListener('abort',cancel));}
      }
      return controller.signal;
    });
    try{
      const responses=await Promise.all(requests.map(async(input,index)=>{
        const response=await fetch(input,{signal:signals[index]});
        const metadata=response_metadata(response);
        if(metadata.status<200||metadata.status>299)throw new TypeError('Cache add request failed');
        validate_put(request_data(input),metadata);return response;
      }));
      const entries=await Promise.all(responses.map(async(response,index)=>({request:request_data(requests[index]),response:await snapshot(response)})));
      await command({cache:id,method:'batch',entries});
    }catch(error){abort.abort(error);throw error;}
    finally{for(const remove of cleanup)remove();}
  }
  class Cache {
    constructor(...args){if(args[0]!==token)throw new TypeError('Illegal constructor');caches.set(this,args[1]);}
    async match(input,options={}){cache_state(this);required(arguments,1);return response_from(await call(this,'match',request(input),query_options(options)));}
    async matchAll(input=undefined,options={}){cache_state(this);return (await call(this,'matchAll',input===undefined?undefined:request(input),query_options(options))).map(response_from);}
    async keys(input=undefined,options={}){cache_state(this);return (await call(this,'keys',input===undefined?undefined:request(input),query_options(options))).map(data=>restore_cached_request(data,RequestClass));}
    async delete(input,options={}){cache_state(this);required(arguments,1);return call(this,'delete',request(input),query_options(options));}
    async put(input,response){
      const id=cache_state(this);required(arguments,2);const data=request(input);
      response_body.call(response);validate_put(data,response_metadata(response));
      const saved=await snapshot(response);await command({cache:id,method:'put',request:data,response:saved});
    }
    async add(input){cache_state(this);required(arguments,1);return add_all(this,[input]);}
    async addAll(inputs){cache_state(this);required(arguments,1);return add_all(this,inputs);}
  }
  class CacheStorage {
    constructor(...args){if(args[0]!==token)throw new TypeError('Illegal constructor');managers.add(this);}
    async open(name){manager(this);required(arguments,1);return new Cache(token,await command({method:'open',name:`${name}`}));}
    async has(name){manager(this);required(arguments,1);return command({method:'has',name:`${name}`});}
    async delete(name){manager(this);required(arguments,1);return command({method:'delete',name:`${name}`});}
    async keys(){manager(this);return command({method:'keys'});}
    async match(input,options={}){manager(this);required(arguments,1);return response_from(await command({method:'match',request:request(input),options:query_options(options,true)}));}
  }
  Object.defineProperty(Cache.prototype,Symbol.toStringTag,{value:'Cache',configurable:true});
  Object.defineProperty(CacheStorage.prototype,Symbol.toStringTag,{value:'CacheStorage',configurable:true});
  for(const prototype of [Cache.prototype,CacheStorage.prototype])for(const name of Object.getOwnPropertyNames(prototype))if(name!=='constructor')Object.defineProperty(prototype,name,{enumerable:true});
  return {Cache,CacheStorage,caches:new CacheStorage(token)};
}
