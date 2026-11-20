import {ProxyFrame,iframes} from './controller.mjs';
import * as rpc from '../rpc.mjs';
import * as network from './network.mjs';
import {indexed_db} from './indexeddb.mjs';
import {normalize_registration} from '../service_worker/registration.mjs';

const owners=new Map();
rpc.rpc_handlers.service_worker_command=(id,method,args)=>{
  const owner=owners.get(id);
  if(!owner||iframes[id]!==owner.frame||!owner.frame.service_worker_host)throw new DOMException('Unknown service worker owner','SecurityError');
  if(typeof method!=='string'||!Array.isArray(args))throw new TypeError('Invalid service worker owner command');
  if(!owner.command)throw new DOMException('Service worker owner command is unavailable','NotSupportedError');
  return owner.command(method,args);
};

export async function create_service_worker_driver(profile,{command,timeout=30000}={}){
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
    dispatch(event){
      if(closed)throw new DOMException('Service worker owner was terminated','InvalidStateError');
      const id=++next,result=call('dispatch',[{...event,id}],event.ports||[]),lifetime=call('wait',[id]);
      result.catch(()=>{});lifetime.catch(()=>{});
      return {id,result,lifetime,read:()=>call('read',[id]),cancel:reason=>call('cancel',[id,reason]),
        handled:error=>call('handled',[id,error]),release:()=>call('release',[id])};
    },
    close(reason=new DOMException('Service worker owner was terminated','AbortError')){
      if(closed)return;closed=true;owners.delete(frame.id);abort.abort(reason);
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
  owners.set(frame.id,owner);document.body.append(frame.iframe);
  try{
    await frame.navigate_to(normalized.scriptURL);abort.signal.throwIfAborted();
    await rpc.call_procedure(frame.rpc_target,'service_worker_start',[{...normalized,source:profile.source,referrerPolicy:profile.referrerPolicy},timeout],{signal:abort.signal});
    return owner;
  }catch(error){owner.close(error);throw error;}
}
