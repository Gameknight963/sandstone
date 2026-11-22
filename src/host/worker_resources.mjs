import {iframes} from './frames.mjs';
import {notify} from '../rpc.mjs';

// Registration completion belongs to the host, not to the worker's event
// loop: the worker may post a message and then remain busy indefinitely.
export function worker_resource_done(frame_id,kind,id){
  const frame=iframes[frame_id];if(!frame?.worker)return;
  try{
    if(frame.worker_resource){frame.worker_resource(kind,id);return;}
    const root=iframes[frame.root_id],parent=iframes[frame.parent_id];
    if(!root||!parent||frame.parent_context!==parent.document_context)return;
    const port=parent===root?root.rpc_target.target:root.rpc_target.extra_frame_targets.get(parent.id);
    if(port)notify(port,'worker_resource_done',[frame_id,kind,id]);
  }catch{}
}
