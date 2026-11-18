const noBody=new Set([204,205,304]);
export const metadata_header='x-sandstone-cache-record';
export const request_fields=['method','mode','credentials','cache','redirect','referrer','referrerPolicy','integrity','keepalive'];

export function request_data(request){
  return {url:request.url,headers:[...request.headers],...Object.fromEntries(request_fields.map(key=>[key,request[key]]))};
}
export function restore_request(data,RequestClass=Request){
  const {url,...options}=data;return new RequestClass(url,options);
}
export function restore_cached_request(data,RequestClass=Request){
  // Cache keys have no-cors mode but retain headers that a new no-cors Request
  // constructor would discard. Keep those native headers and expose the saved
  // cache-key fields, including on clones.
  const request=restore_request({...data,mode:'cors'},RequestClass);
  Object.defineProperty(request,'mode',{value:data.mode});
  Object.defineProperty(request,'clone',{value:()=>restore_cached_request(request_data(request),RequestClass)});
  return request;
}
export function validate_put(request,response){
  if(!['http:','https:'].includes(new URL(request.url).protocol)||request.method!=='GET')throw new TypeError('Cache writes require an HTTP(S) GET request');
  if(response.status===206)throw new TypeError('This response cannot be cached');
  if(new Headers(response.headers).get('vary')?.split(',').some(value=>value.trim()==='*'))throw new TypeError('Vary: * cannot be cached');
}
export function matches(request,entry,options={}){
  if(!request)return true;
  if(!options.ignoreMethod&&request.method!=='GET')return false;
  const a=new URL(request.url),b=new URL(entry.request.url);a.hash=b.hash='';
  if(options.ignoreSearch)a.search=b.search='';
  if(a.href!==b.href)return false;
  if(options.ignoreVary)return true;
  const vary=new Headers(entry.response.headers).get('vary');
  if(!vary)return true;
  const actual=new Headers(request.headers),stored=new Headers(entry.request.headers);
  return vary.split(',').map(value=>value.trim()).filter(Boolean).every(name=>name!=='*'&&actual.get(name)===stored.get(name));
}
export function stored_response(data){
  const headers=new Headers(data.headers);
  headers.set(metadata_header,encodeURIComponent(JSON.stringify({headers:data.headers,items:data.items})));
  return new Response(noBody.has(data.items.status)?null:data.body,{status:data.items.status||200,statusText:data.items.statusText,headers});
}
export async function response_data(response){
  if(!response)return undefined;
  const encoded=response.headers.get(metadata_header);
  const saved=encoded?JSON.parse(decodeURIComponent(encoded)):{headers:[...response.headers],items:{status:response.status,statusText:response.statusText,url:response.url,type:response.type,redirected:response.redirected}};
  return {...saved,body:response.body===null?null:await response.blob()};
}

// The same matching model backs denied-storage sessions. No native fetch is
// used here: add/addAll obtain their responses through the frame's relay.
class MemoryCache {
  entries=[];
  query(request,options){return this.entries.filter(entry=>matches(request,entry,options));}
  async match(request,options){return this.query(request,options)[0]?.response.clone();}
  async matchAll(request,options){return this.query(request,options).map(entry=>entry.response.clone());}
  async keys(request,options){return this.query(request,options).map(entry=>restore_cached_request({url:entry.request.url,method:entry.request.method,headers:[...entry.request.headers],mode:'no-cors',credentials:'omit',referrer:'',cache:'default',redirect:'follow',referrerPolicy:'',integrity:'',keepalive:false}));}
  async delete(request,options){const before=this.entries.length;this.entries=this.entries.filter(entry=>!matches(request,entry,options));return this.entries.length!==before;}
  async put(request,response){
    validate_put(request,response);
    const body=response.body===null?null:await response.blob();
    this.entries=this.entries.filter(entry=>!matches(request,entry,{ignoreVary:true}));
    this.entries.push({request:request.clone(),response:new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers})});
  }
}
export class MemoryCacheStorage {
  caches=new Map();
  async keys(){return [...this.caches.keys()];}
  async open(name){if(!this.caches.has(name))this.caches.set(name,new MemoryCache());return this.caches.get(name);}
  async delete(name){return this.caches.delete(name);}
}
