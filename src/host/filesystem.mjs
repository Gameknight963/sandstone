import {FileService} from '../filesystem/service.mjs';
import {beacons} from './network.mjs';
import {rpc_handlers,call_procedure,notify} from '../rpc.mjs';
import {site_data} from './site_data.mjs';
import {iframes} from './controller.mjs';
import {estimate_storage} from '../filesystem/estimate.mjs';
import {worker_renderer} from '../filesystem/worker_context.mjs';
let factory,manager;
try{factory=globalThis.indexedDB;}catch{}
try{manager=globalThis.navigator?.storage;}catch{}
export const file_system=new FileService(factory,{onCatalog:catalog=>site_data.fileSystems=catalog});
const sync_channels=new Map();
export function disconnect_file_worker(token){
  const channel=sync_channels.get(token);if(!channel)return;
  sync_channels.delete(token);channel.controller.abort(new DOMException('Worker was retired','AbortError'));
  if(iframes[channel.renderer]?.document_context===channel.context)notify(channel.target,'filesystem_sync_close',[token]);
}
rpc_handlers.filesystem_sync_open=async(id,token,port)=>{
  const frame=iframes[id],entry=beacons.contexts.get(token);
  if(!frame?.worker||frame.document_context!==token||!entry||entry.retired||entry.frame!==id||!(port instanceof MessagePort)||typeof SharedArrayBuffer==='undefined')throw new DOMException('Worker file context is unavailable','SecurityError');
  const renderer=worker_renderer(iframes,id),root=renderer&&iframes[renderer.root_id];
  const target=renderer?.id===root?.id?root?.rpc_target.target:root?.rpc_target.extra_frame_targets.get(renderer?.id);
  if(!target)throw new DOMException('Worker renderer is unavailable','InvalidStateError');
  disconnect_file_worker(token);
  const channel={renderer:renderer.id,context:renderer.document_context,target,controller:new AbortController()};
  sync_channels.set(token,channel);
  try{
    // The host forwards only the port. Shared memory remains between workers
    // and their owning renderer, which belong to the same agent cluster.
    await call_procedure(target,'filesystem_sync_bind',[id,token,port],{transfer:[port],signal:channel.controller.signal});
    if(entry.retired||iframes[id]!==frame)throw new DOMException('Worker was retired','AbortError');
  }catch(error){if(sync_channels.get(token)===channel)disconnect_file_worker(token);port.close();throw error;}
};
rpc_handlers.filesystem_sync_command=(renderer,id,token,command)=>{
  if(worker_renderer(iframes,id)?.id!==renderer||iframes[id]?.document_context!==token)throw new DOMException('Worker file context is unavailable','SecurityError');
  return rpc_handlers.filesystem_command(token,command);
};
rpc_handlers.filesystem_command=async(token,command)=>{
  const entry=beacons.contexts.get(token);if(!entry||entry.retired)throw new DOMException('File document is unavailable','InvalidStateError');
  const context=entry.context,origin=context.broadcast_origin||new URL(context.url).origin;
  if(origin==='null'||origin.startsWith('opaque:'))throw new DOMException('File origin is unavailable','SecurityError');
  if(command?.op==='estimate'){
    const catalog=await file_system.storage.catalog(),usage=catalog.find(info=>info.origin===origin)?.usage||0;
    let quota=512*1024*1024;if(file_system.storage.persistent)try{quota=(await manager?.estimate())?.quota||quota;}catch{}
    return estimate_storage(origin,site_data,usage,quota);
  }
  if(command?.op==='persisted'||command?.op==='persist'){
    await file_system.storage.ready;if(!file_system.storage.persistent)return false;
    try{return !!await manager?.[command.op]();}catch{return false;}
  }
  try{return await file_system.command(origin,token,command);}
  finally{if(entry.retired)file_system.release(token);}
};
