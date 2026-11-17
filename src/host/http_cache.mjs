const cacheable_status = new Set([200,203,204,300,301,308,404,405,410,414,501]);
const conditional_headers = ['if-match','if-none-match','if-modified-since','if-unmodified-since','if-range'];
const directives = value => {
  const result=new Map();
  for(const part of String(value||'').split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)){
    const index=part.indexOf('='),name=part.slice(0,index<0?undefined:index).trim().toLowerCase();
    result.set(name,name==='max-age'&&result.has(name)?'0':index<0?'':part.slice(index+1).trim().replace(/^"|"$/g,''));
  }
  return result;
};
const seconds = value => /^\d+$/.test(value || '') ? Math.min(Number(value),2147483648) * 1000 : null;
const date = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const origin = value => {try{return new URL(value).origin;}catch{return '';}};
const url_key = value => {const url=new URL(value);url.hash='';return url.href;};
const saved_headers = headers => {const result=new Headers(headers);result.delete('set-cookie');result.delete('set-cookie2');return result;};

// Private, memory-only HTTP cache. Store bytes only after a complete successful
// read; a canceled/failed or oversized response cannot leave a partial entry.
export class HTTPCache {
  constructor({maxBytes=16*1024*1024,maxEntryBytes=4*1024*1024,maxEntries=256,now=()=>Date.now()}={}) {
    Object.assign(this,{maxBytes,maxEntryBytes,maxEntries,now});
    this.entries=new Map();this.bytes=0;this.pendingBytes=0;this.pendingWrites=new Set();
  }
  remove(key) {
    const entry=this.entries.get(key);
    if(entry){this.bytes-=entry.body.byteLength;this.entries.delete(key);}
  }
  clear(hostname) {
    const matches=value=>{try{const host=new URL(value).hostname;return host===hostname||host.endsWith('.'+hostname);}catch{return false;}};
    for(const write of this.pendingWrites)if(!hostname||[write.url,...write.partition].some(matches))write.valid=false;
    for(const [key,entry] of this.entries)if(!hostname||[entry.url,...entry.partition].some(matches))this.remove(key);
  }
  invalidate(url) {
    for(const write of this.pendingWrites)if(write.url===url_key(url))write.valid=false;
    for(const [key,entry] of this.entries)if(entry.url===url_key(url))this.remove(key);
  }
  timing(headers,received,started=received) {
    const control=directives(headers.get('cache-control'));
    const issued=date(headers.get('date'))??received;
    const age=Math.max(0,received-issued, (seconds(headers.get('age'))||0)+received-started);
    let lifetime=control.has('max-age')?seconds(control.get('max-age'))??0:null;
    if(lifetime===null){
      const expires=date(headers.get('expires')),modified=date(headers.get('last-modified'));
      lifetime=expires!==null?Math.max(0,expires-issued):modified!==null?Math.min(86400000,Math.max(0,(issued-modified)/10)):0;
    }
    return {control,age,lifetime,received};
  }
  store(entry,write) {
    if(!write.valid||entry.body.byteLength>Math.min(this.maxBytes,this.maxEntryBytes))return;
    const control=directives(entry.headers.get('cache-control'));
    if(control.has('no-store'))return;
    for(const [key,previous] of this.entries)if(previous.base===entry.base&&JSON.stringify(previous.vary)!==JSON.stringify(entry.vary))this.remove(key);
    this.remove(entry.key);
    this.entries.set(entry.key,entry);this.bytes+=entry.body.byteLength;
    while(this.bytes>this.maxBytes||this.entries.size>this.maxEntries)this.remove(this.entries.keys().next().value);
  }
  response(entry,headers=entry.headers) {
    const output=new Headers(headers);
    output.set('age',String(Math.max(0,Math.floor((entry.timing.age+this.now()-entry.timing.received)/1000))));
    const response=new Response([204,205,304].includes(entry.status)?null:entry.body.slice(),{status:entry.status,statusText:entry.statusText,headers:output});
    Object.defineProperty(response,'raw_headers',{value:[...output],configurable:true});
    return response;
  }
  async fetch(transport,input,init={},context={}) {
    init.signal?.throwIfAborted();
    const url=url_key(input),method=(init.method||'GET').toUpperCase(),headers=new Headers(init.headers);
    let mode=init.cache||'default';
    const request_control=directives(headers.get('cache-control'));
    const conditional=conditional_headers.some(name=>headers.has(name));
    if(mode==='default'&&conditional)mode='no-cache';
    if(mode==='no-cache'&&!headers.has('cache-control'))headers.set('cache-control','max-age=0');
    if(mode==='no-store'||mode==='reload'){
      if(!headers.has('pragma'))headers.set('pragma','no-cache');
      if(!headers.has('cache-control'))headers.set('cache-control','no-cache');
    }
    const partition=[origin(context.top_url||context.url||url),origin(context.url||url)];
    if(context.broadcast_origin?.startsWith('opaque:'))partition.push(context.broadcast_origin);
    const base=JSON.stringify([url,method,...partition,init.credentials||'include',headers.get('cookie'),headers.get('authorization'),headers.get('origin')]);
    const eligible=['GET','HEAD'].includes(method)&&!conditional&&!headers.has('range')&&!request_control.has('no-store')&&mode!=='no-store';
    let stored;
    if(eligible&&mode!=='reload')for(const entry of this.entries.values()){
      if(entry.base===base&&entry.vary.every(name=>headers.get(name)===entry.request.get(name))){stored=entry;break;}
    }
    if(stored){
      const current_age=stored.timing.age+this.now()-stored.timing.received;
      const max_age=seconds(request_control.get('max-age'));
      const min_fresh=seconds(request_control.get('min-fresh'))||0;
      const fresh=current_age+min_fresh<stored.timing.lifetime&&(max_age===null||current_age<=max_age);
      const validation=stored.vary.includes('*')||stored.timing.control.has('no-cache')||request_control.has('no-cache')||(headers.get('pragma')||'').toLowerCase().split(',').some(value=>value.trim()==='no-cache')||mode==='no-cache';
      if(!validation&&(fresh||['force-cache','only-if-cached'].includes(mode))){
        this.entries.delete(stored.key);this.entries.set(stored.key,stored);
        return this.response(stored);
      }
      if(!conditional){
        if(stored.headers.has('etag'))headers.set('if-none-match',stored.headers.get('etag'));
        if(stored.headers.has('last-modified')&&!stored.vary.includes('*'))headers.set('if-modified-since',stored.headers.get('last-modified'));
      }
    }
    if(mode==='only-if-cached')throw new TypeError('No cached response available');
    const options={...init,headers:Object.fromEntries(headers),cache:'no-store'};
    const write={valid:true,url,partition},started=this.now();
    if(eligible)this.pendingWrites.add(write);
    let response;
    try{response=await transport(url,options);}catch(error){this.pendingWrites.delete(write);throw error;}
    const received=this.now();
    if(!['GET','HEAD','OPTIONS','TRACE'].includes(method)&&response.status>=200&&response.status<400){
      this.invalidate(url);
      for(const name of ['location','content-location']){
        const value=response.headers.get(name);
        if(value){try{const target=new URL(value,url);if(target.origin===new URL(url).origin)this.invalidate(target.href);}catch{}}
      }
    }
    if(stored&&response.status===304&&!conditional){
      await response.body?.cancel();
      const merged=new Headers(stored.headers);
      for(const [name,value] of response.headers)if(name!=='content-length')merged.set(name,value);
      const updated={...stored,headers:saved_headers(merged),timing:this.timing(merged,received,started)};
      updated.vary=[...new Set((updated.headers.get('vary')||'').split(',').map(value=>value.trim().toLowerCase()).filter(Boolean))].sort();
      updated.request=new Headers(headers);
      updated.key=JSON.stringify([base,updated.vary.map(name=>[name,headers.get(name)])]);
      this.remove(stored.key);
      this.store(updated,write);this.pendingWrites.delete(write);
      const output=this.response(updated);
      const cookie_headers=(response.raw_headers||[...response.headers]).filter(([name])=>['set-cookie','set-cookie2'].includes(name.toLowerCase()));
      Object.defineProperty(output,'raw_headers',{value:[...output.headers,...cookie_headers],configurable:true});
      return output;
    }
    const timing=this.timing(response.headers,received,started);
    if(eligible&&timing.control.has('no-store'))for(const [key,entry] of this.entries){
      if(entry.base===base&&entry.vary.every(name=>headers.get(name)===entry.request.get(name)))this.remove(key);
    }
    const explicit=response.headers.has('expires')||timing.control.has('max-age')||timing.control.has('public');
    if(!eligible||timing.control.has('no-store')||(!cacheable_status.has(response.status)&&!explicit)||response.status===206||response.status===304||response.headers.get('content-type')?.startsWith('text/event-stream')){
      this.pendingWrites.delete(write);return response;
    }
    const vary=[...new Set((response.headers.get('vary')||'').split(',').map(value=>value.trim().toLowerCase()).filter(Boolean))].sort();
    const entry={base,url,method,partition,status:response.status,statusText:response.statusText,headers:saved_headers(response.headers),request:new Headers(headers),vary,timing,body:null};
    entry.key=JSON.stringify([base,vary.map(name=>[name,headers.get(name)])]);
    if(!response.body||method==='HEAD'){
      entry.body=new Uint8Array();this.store(entry,write);this.pendingWrites.delete(write);
      if(method!=='HEAD')return response;
      await response.body?.cancel();
      const output=new Response([204,205,304].includes(response.status)?null:new Uint8Array(),{status:response.status,statusText:response.statusText,headers:response.headers});
      Object.defineProperty(output,'raw_headers',{value:response.raw_headers||[...response.headers]});return output;
    }
    const reader=response.body.getReader(),chunks=[];
    const cache=this;
    let size=0,collected=0,collect=true;
    const release=()=>{cache.pendingBytes-=collected;collected=0;chunks.length=0;cache.pendingWrites.delete(write);};
    const body=new ReadableStream({
      async pull(controller){
        try{
          const chunk=await reader.read();
          if(chunk.done){
            if(collect){entry.body=new Uint8Array(size);let offset=0;for(const chunk of chunks){entry.body.set(chunk,offset);offset+=chunk.byteLength;}cache.store(entry,write);}
            release();
            controller.close();return;
          }
          size+=chunk.value.byteLength;
          if(collect&&size<=Math.min(cache.maxBytes,cache.maxEntryBytes)&&cache.pendingBytes+chunk.value.byteLength<=cache.maxBytes){
            chunks.push(chunk.value.slice());collected+=chunk.value.byteLength;cache.pendingBytes+=chunk.value.byteLength;
          }else{collect=false;release();}
          controller.enqueue(chunk.value);
        }catch(error){collect=false;release();controller.error(error);}
      },
      cancel(reason){release();collect=false;return reader.cancel(reason);}
    });
    const output=new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    Object.defineProperty(output,'raw_headers',{value:response.raw_headers||[...response.headers]});
    return output;
  }
}

export const http_cache=new HTTPCache();
