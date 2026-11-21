import * as loader from "../loader.mjs";
import { ctx } from "../context.mjs";
import {flush_document_base} from '../document_base.mjs';
import {history_hash} from './history.mjs';
import {encoding_parse_url} from '../../url_encoding.mjs';
import {origin_list} from './origin_list.mjs';
import {create_location} from '../location_interface.mjs';
import {cookie_document_active} from './cookie.mjs';
export {share_location} from '../location_interface.mjs';

export let internal = null;
export function set_location(value) { flush_document_base();internal = new URL(value); loader.set_url(internal.href); }

const NativeWorkerLocation=globalThis.WorkerLocation,worker_locations=new WeakMap();
if(NativeWorkerLocation){
  // Keep the browser's prototype and accessor placement. Only registered
  // facades use virtual URLs; native receivers retain their native slots.
  for(const key of Reflect.ownKeys(NativeWorkerLocation.prototype)){
    const descriptor=Object.getOwnPropertyDescriptor(NativeWorkerLocation.prototype,key);
    if(descriptor.get)Object.defineProperty(NativeWorkerLocation.prototype,key,{...descriptor,get:new Proxy(descriptor.get,{apply(target,receiver,args){
      return worker_locations.has(receiver)?worker_locations.get(receiver)[key]:Reflect.apply(target,receiver,args);
    }})});
    else if(key==='toString')Object.defineProperty(NativeWorkerLocation.prototype,key,{...descriptor,value:new Proxy(descriptor.value,{apply(target,receiver,args){
      return worker_locations.has(receiver)?worker_locations.get(receiver).href:Reflect.apply(target,receiver,args);
    }})});
  }
}
export class FakeWorkerLocation {
  constructor() {
    const url = new URL(loader.url);
    // Native WorkerLocation objects reject structured cloning.
    const facade=new Proxy(Object.create(NativeWorkerLocation.prototype),{}),values={};
    for (const key of ["href", "origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash"]) {
      values[key]=key==='origin'?loader.worker_origin||url.origin:url[key];
    }
    worker_locations.set(facade,values);return facade;
  }
}

export class FakeLocation {
  constructor(options={}) {
    set_location(loader.url);
    const origins=Array.from(options.message_parent?.origins||[]);let ancestors;
    if(globalThis.DOMStringList)Object.defineProperty(this,'ancestorOrigins',{enumerable:true,get:()=>ancestors??=origin_list(origins)});
    for (const key of ["href", "origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash"]) {
      const descriptor = {enumerable: true, get: () => key==='origin'&&internal.protocol==='blob:'?loader.location_origin??internal.origin:internal[key]};
      if (key !== "origin") descriptor.set = value => {
        if (key === "href") { this.assign(value); return; }
        const next = new URL(internal);
        if(key==='hash'){const input=`${value}`;next.hash=input===''?'#':input;}
        else next[key] = value;
        if (key === "hash" && next.hash === internal.hash) return;
        this.assign(next.href);
      };
      Object.defineProperty(this, key, descriptor);
    }
    let document=globalThis.document;
    return create_location({window:()=>globalThis,frame:()=>loader.frame_id,origin:()=>ctx.origin,readable:()=>this.href,
      active:()=>cookie_document_active(document),retarget:()=>{document=globalThis.document;},
      get:key=>this[key],set:(key,value)=>{this[key]=value;},invoke:(name,args)=>Reflect.apply(FakeLocation.prototype[name],this,args)});
  }
  #navigate(value, mode) {
    const text=`${value}`;
    let next;try{next=encoding_parse_url(text,ctx.document.baseURI,loader.character_encoding);}
    catch{throw new DOMException('Invalid navigation URL','SyntaxError');}
    const same_base = next.href.split('#')[0] === internal.href.split('#')[0];
    if (same_base && next.href.includes('#')) {
      history_hash(ctx.history,next.href, mode === "replace");
      return;
    }
    loader.navigate(loader.frame_id, next.href, true, null, {history_mode: mode, scroll: [globalThis.scrollX || 0, globalThis.scrollY || 0]}).catch(console.error);
  }
  assign(value) { this.#navigate(value, "push"); }
  replace(value) { this.#navigate(value, "replace"); }
  reload() { loader.navigate(loader.frame_id, this.href, true, null, {history_mode: "reload", scroll: [globalThis.scrollX || 0, globalThis.scrollY || 0]}).catch(console.error); }
  toString() { return this.href; }
  get [Symbol.toStringTag]() { return "Location"; }
}
