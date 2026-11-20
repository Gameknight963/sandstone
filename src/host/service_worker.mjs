import {ProxyFrame,iframes} from './controller.mjs';
import * as rpc from '../rpc.mjs';
import * as network from './network.mjs';
import {indexed_db} from './indexeddb.mjs';
import {normalize_registration} from '../service_worker/registration.mjs';
import {ServiceWorkerStorage} from '../service_worker/storage.mjs';
import {site_data} from './site_data.mjs';
import {ServiceWorkerManager} from '../service_worker/manager.mjs';
import {ServiceWorkerFetch} from '../service_worker/fetch.mjs';
import {ServiceWorkerClients} from '../service_worker/clients.mjs';
import {ServiceWorkerNavigations} from '../service_worker/navigation.mjs';
import {ServiceWorkerRequests} from '../service_worker/requests.mjs';

let factory;try{factory=globalThis.indexedDB;}catch{}
export const registrations=new ServiceWorkerStorage(factory,{onCatalog:catalog=>site_data.serviceWorkers=catalog});
export const manager=new ServiceWorkerManager({storage:registrations,createWorker:(profile,options)=>create_service_worker_driver(profile,{timeout:300000,...options}),
  fetch:(url,options,context)=>network.fetch(url,options,{...context,service_worker_bypass:true,url:context.url||context.base||url,top_url:context.top_url||context.url||context.base||url})});
export const fetch_router=new ServiceWorkerFetch({manager,client:context=>{
  if(context.service_worker_navigation)return context.service_worker_navigation;
  const frame=iframes[context.frame_id];
  if(!frame||frame.service_worker_host||iframes[frame.root_id]?.service_worker_host)return null;
  const client=manager.clients.get(context.service_worker_client);
  return client?.frame===frame.id?client:null;
}});
export const clients=new ServiceWorkerClients({manager,frames:()=>iframes});
export const navigations=new ServiceWorkerNavigations({manager,frames:()=>iframes,route:(...args)=>fetch_router.fetch(...args)});
network.set_service_worker_fetch((url,options,context,network)=>context?.navigation?navigations.fetch(url,options,context,network):fetch_router.fetch(url,options,context,network),
  (frame,options)=>{clients.disconnect(frame);navigations.disconnect(frame,options);},(frame,signal)=>clients.bind(frame,signal),
  Object.fromEntries(['response','commit','cancel','reserved'].map(key=>[key,navigations[key].bind(navigations)])));
export async function clear_registrations(hostname){
  manager.revoke(hostname);
  for(const owner of [...owners.values()])if(new URL(owner.profile.origin).hostname===hostname)owner.close();
  await registrations.clear(hostname);
}

const owners=new Map();
export const request_contexts=new ServiceWorkerRequests();
network.set_service_worker_request_context((id,token,url)=>{
  const frame=iframes[id],owner=frame&&owners.get(frame.root_id);
  if(!frame?.worker||!owner||!owner.frame.service_worker_host)throw new DOMException('Not a service worker request owner','SecurityError');
  return request_contexts.restore(owner.frame.id,token,url);
});
rpc.rpc_handlers.service_worker_command=(id,method,args)=>{
  const owner=owners.get(id);
  if(!owner||iframes[id]!==owner.frame||!owner.frame.service_worker_host)throw new DOMException('Unknown service worker owner','SecurityError');
  if(typeof method!=='string'||!Array.isArray(args))throw new TypeError('Invalid service worker owner command');
  if(!owner.command)throw new DOMException('Service worker owner command is unavailable','NotSupportedError');
  return owner.command(method,args);
};

export async function create_service_worker_driver(profile,{command,timeout=30000,signal}={}){
  signal?.throwIfAborted();
  const normalized=normalize_registration(profile.scriptURL,profile,{base:profile.scriptURL});
  if(typeof profile.source!=='string')throw new TypeError('A validated service worker script is required');
  const frame=new ProxyFrame(),abort=new AbortController();let next=0,closed=false;
  frame.service_worker_host=true;
  frame.iframe.removeAttribute('frame-id');frame.iframe.hidden=true;
  frame.iframe.setAttribute('data-service-worker-owner','');frame.iframe.style.display='none';
  frame.special_pages[normalized.scriptURL]='<!doctype html><title>Service worker owner</title>';
  function call(method,args=[],transfer){
    return rpc.call_procedure(frame.rpc_target,'service_worker_control',[method,...args],{signal:abort.signal,transfer});
  }
  const owner={frame,command,profile:normalized,
    scripts:()=>call('scripts'),
    dispatch(event){
      if(closed)throw new DOMException('Service worker owner was terminated','InvalidStateError');
      const {request_context,...packet}=event;
      if(packet.request&&request_context)packet.request={...packet.request,context:request_contexts.issue(frame.id,packet.request.url,request_context)};
      const id=++next,result=call('dispatch',[{...packet,id}],event.ports||[]),lifetime=call('wait',[id]);
      result.catch(()=>{});lifetime.catch(()=>{});
      return {id,result,lifetime,read:()=>call('read',[id]),cancel:reason=>call('cancel',[id,reason]),
        abort:reason=>call('abort',[id,reason]),handled:error=>call('handled',[id,error]),release:()=>call('release',[id])};
    },
    close(reason=new DOMException('Service worker owner was terminated','AbortError')){
      if(closed)return;closed=true;owners.delete(frame.id);request_contexts.disconnect(frame.id);abort.abort(reason);
      signal?.removeEventListener('abort',externalAbort);
      try{rpc.notify(frame.rpc_target,'service_worker_control',['close']);}catch{}
      frame.runtime_wait?.abort(reason);frame.navigation_id++;frame.is_navigating=false;
      frame.iframe.remove();
      for(const [id,child] of Object.entries(iframes))if(child.root_id===frame.id){indexed_db.disconnect(id);network.clean_ws_connections(id);delete iframes[id];}
      const target=frame.rpc_target;
      for(const close of [...target.retired_targets.values()])close();
      for(const port of [target.target,...target.extra_targets]){port?.removeEventListener('message',target.msg_callback);port?.close?.();}
      target.extra_targets=[];target.extra_frame_targets.clear();
      if(frame.runtime_url)URL.revokeObjectURL(frame.runtime_url);
    }
  };
  const externalAbort=()=>owner.close(signal.reason);
  signal?.addEventListener('abort',externalAbort,{once:true});
  owners.set(frame.id,owner);document.body.append(frame.iframe);
  try{
    signal?.throwIfAborted();
    await frame.navigate_to(normalized.scriptURL);abort.signal.throwIfAborted();
    await rpc.call_procedure(frame.rpc_target,'service_worker_start',[{...normalized,source:profile.source,referrerPolicy:profile.referrerPolicy,scripts:profile.scripts,restoring:!!profile.restoring},timeout],{signal:abort.signal});
    return owner;
  }catch(error){owner.close(error);throw error;}
}
