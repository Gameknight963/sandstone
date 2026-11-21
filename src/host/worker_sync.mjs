import {beacons} from './network.mjs';
import {iframes} from './frames.mjs';
import {rpc_handlers,call_procedure,notify} from '../rpc.mjs';
import {worker_renderer} from '../worker_context.mjs';

const channels=new Map();
export function disconnect_worker_sync(token){
  const channel=channels.get(token);if(!channel)return;
  channels.delete(token);channel.controller.abort(new DOMException('Worker was retired','AbortError'));
  if(iframes[channel.renderer]?.document_context===channel.context)notify(channel.target,'worker_sync_close',[token]);
}
rpc_handlers.worker_sync_open=async(id,token,port,options)=>{
  const frame=iframes[id],entry=beacons.contexts.get(token);
  if(!frame?.worker||frame.document_context!==token||!entry||entry.retired||entry.frame!==id||!(port instanceof MessagePort)||typeof SharedArrayBuffer==='undefined')throw new DOMException('Worker context is unavailable','SecurityError');
  const renderer=worker_renderer(iframes,id),root=renderer&&iframes[renderer.root_id];
  const target=renderer?.id===root?.id?root?.rpc_target.target:root?.rpc_target.extra_frame_targets.get(renderer?.id);
  if(!target)throw new DOMException('Worker renderer is unavailable','InvalidStateError');
  disconnect_worker_sync(token);
  const channel={renderer:renderer.id,context:renderer.document_context,target,controller:new AbortController()};
  channels.set(token,channel);
  try{
    // Only the port crosses the outer host. Shared memory stays within the
    // worker's agent cluster, with an endpoint in its nonblocking renderer.
    await call_procedure(target,'worker_sync_bind',[id,token,port,{url:frame.url.href,referrerPolicy:options?.referrerPolicy}],{transfer:[port],signal:channel.controller.signal});
    if(entry.retired||iframes[id]!==frame)throw new DOMException('Worker was retired','AbortError');
  }catch(error){if(channels.get(token)===channel)disconnect_worker_sync(token);port.close();throw error;}
};
rpc_handlers.worker_sync_request=(renderer,id,token,method,args)=>{
  const frame=iframes[id],entry=beacons.contexts.get(token);
  if(worker_renderer(iframes,id)?.id!==renderer||frame?.document_context!==token||!entry||entry.retired)throw new DOMException('Worker context is unavailable','SecurityError');
  if(method==='file')return rpc_handlers.filesystem_command(token,args);
  if(!Array.isArray(args))throw new TypeError('Invalid synchronous worker request');
  if(method==='script')return rpc_handlers.fetch_worker_script(frame.parent_id,id,...args);
  if(method==='fetch')return rpc_handlers.fetch_worker_request(frame.parent_id,id,...args);
  if(method==='read')return rpc_handlers.fetch_read(id,...args);
  if(method==='abort')return rpc_handlers.fetch_abort(id,...args);
  throw new TypeError('Unknown synchronous worker request');
};
