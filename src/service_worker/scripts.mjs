import {validate_module_response} from '../frame/modules.mjs';
const clone=globalThis.structuredClone?.bind(globalThis)??(value=>JSON.parse(JSON.stringify(value)));
const then=Promise.prototype.then;

// Registration scripts have their own resource map, separate from CacheStorage
// and the HTTP cache. A restarted worker must use that installed version.
export class ServiceWorkerScripts{
  constructor(scripts=[],{restoring=false}={}){
    this.entries=new Map();this.pending=new Map();this.restoring=restoring;
    for(const script of scripts)this.set(script);
  }
  set(script){
    if(typeof script.source!=='string')throw new TypeError('Invalid service worker script source');
    const value=clone({...script,url:new URL(script.url).href,headers:[...new Headers(script.headers||{'content-type':'text/javascript'})]});
    this.entries.set(value.url,value);return value;
  }
  response(script,type){
    const status=script.status??200,response=new Response([204,205,304].includes(status)?null:script.source,{status,statusText:script.statusText||'',headers:script.headers});
    if(!response.ok)throw new TypeError('Service worker script request failed: '+response.status);
    for(const [key,value] of Object.entries({url:script.responseURL||script.url,redirected:!!script.redirected,type:script.type||'basic',request_cross_origin:script.request_cross_origin}))Object.defineProperty(response,key,{value});
    validate_module_response(response,type,script.url);return response;
  }
  async fetch(url,options,type,fetch){
    const key=new URL(url).href,saved=this.entries.get(key);
    if(saved)return this.response(saved,type);
    if(this.restoring)throw new DOMException('Script is absent from the installed service worker','NetworkError');
    if(!this.pending.has(key)){
      const pending=(async()=>{
        const response=await fetch(key,options);
        if(!response.ok)throw new TypeError('Service worker script request failed: '+response.status);
        validate_module_response(response,type,key);
        const script=this.set({url:key,responseURL:response.url||key,status:response.status,statusText:response.statusText,
          headers:[...response.headers],type:response.type,redirected:response.redirected,request_cross_origin:response.request_cross_origin,source:await response.text()});
        return script;
      })();
      this.pending.set(key,pending);
      const cleanup=()=>{if(this.pending.get(key)===pending)this.pending.delete(key);};
      Reflect.apply(then,pending,[cleanup,cleanup]);
    }
    return this.response(await this.pending.get(key),type);
  }
  snapshot(){return clone([...this.entries.values()]);}
}
