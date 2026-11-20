import * as loader from '../loader.mjs';
import * as rpc from '../../rpc.mjs';
import {ctx} from '../context.mjs';
import {create_service_worker_client} from '../../service_worker/client.mjs';
import {encode_message} from './crypto.mjs';
import {trustworthy_url} from '../../trustworthy.mjs';
import {listen_runtime,on_document_unload} from '../runtime_events.mjs';

let current,port,context;
const nativeDocument=globalThis.document,hasFocus=globalThis.Document?.prototype.hasFocus;
const visibility=globalThis.Document&&Object.getOwnPropertyDescriptor(Document.prototype,'visibilityState')?.get;
rpc.rpc_handlers.service_worker_window=token=>{
  if(loader.beacon_context&&token!==loader.beacon_context)throw new DOMException('Document was replaced','AbortError');
  return {visibilityState:visibility?Reflect.apply(visibility,nativeDocument,[]):'visible',focused:!!(hasFocus&&Reflect.apply(hasFocus,nativeDocument,[]))};
};
export const service_worker_api=()=>current;
export const service_worker_snapshot=()=>current?.snapshot();
export function configure_service_workers(options){
  if(typeof Navigator==='undefined')return;
  const origin=ctx.origin,available=origin!=='null'&&trustworthy_url(new URL(origin))&&!loader.service_worker_host;
  if(!available){try{Reflect.deleteProperty(Navigator.prototype,'serviceWorker');}catch{}return;}
  if(context===loader.beacon_context&&current)return;
  current?.close();port?.close();context=loader.beacon_context;
  current=create_service_worker_client({base:()=>ctx.document.baseURI,origin:()=>ctx.origin,encode:encode_message,
    command:(method,args,ports)=>rpc.call_procedure(rpc.host,'service_worker_client',[loader.frame_id,options.beacon_context,method,args],{transfer:ports})});
  Object.defineProperty(Navigator.prototype,'serviceWorker',{configurable:true,enumerable:true,get(){if(!(this instanceof Navigator))throw new TypeError('Illegal navigator receiver');return current.container;}});
  if(options.service_worker_state)current.apply({revision:-1,registrations:[],ready:null,...options.service_worker_state});
  const channel=new MessageChannel();port=channel.port1;const api=current;
  port.onmessage=event=>api.receive(event.data);port.start();
  listen_runtime(document,'DOMContentLoaded',()=>api.container.startMessages(),{once:true});
  on_document_unload(()=>{api.close();channel.port1.close();});
  return rpc.call_procedure(rpc.host,'service_worker_open',[loader.frame_id,context,channel.port2],{transfer:[channel.port2]}).then(snapshot=>api.apply(snapshot)).catch(()=>{});
}
