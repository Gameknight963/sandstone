import {same_site} from './request.mjs';

export function navigation_request_context(contexts,snapshot,root_id){
  const entry=contexts.get(snapshot?.document);
  if(!entry||entry.frame!==snapshot.frame||entry.context.root_id!==root_id)throw new TypeError('Unknown navigation source');
  const url=new URL(snapshot.url),original=new URL(entry.context.url);
  if(url.origin!==original.origin||url.username!==original.username||url.password!==original.password)throw new TypeError('Invalid navigation source URL');
  // Accepted navigation can outlive its initiator. Copy the original document
  // context now, rather than looking it up again after headers or body arrive.
  return Object.freeze({...entry.context,url:url.href,navigation:true,nested:true});
}

export function frame_cross_site(frame,frames) {
  const root=frames[frame.root_id]||frame,top=new URL(root.url);
  for(let current=frame;current;current=frames[current.parent_id]){
    if(current.broadcast_origin?.startsWith('opaque:'))return true;
    let url=new URL(current.url);
    if(url.origin==='null'&&current.origin&&current.origin!=='null')url=new URL(current.origin);
    if(!same_site(top,url))return true;
  }
  return false;
}

export function worker_script_frame(frames,parent_id,worker_id){
  const parent=frames[parent_id],worker=frames[worker_id];
  if(!parent||!worker?.worker||worker.parent_id!==parent_id||worker.parent_context!==parent.document_context)throw new DOMException('Unknown worker owner','SecurityError');
  const origin=parent.origin||new URL(parent.url).origin;
  const url=worker_script_url(worker.url,origin);
  if(worker.origin!==(url.protocol==='data:'?'null':origin))throw new DOMException('Invalid worker origin','SecurityError');
  return worker;
}

export function worker_script_url(input,origin){
  const url=new URL(input);
  if(!['http:','https:','data:','blob:'].includes(url.protocol)||url.origin!=='null'&&url.origin!==origin)throw new DOMException('Invalid worker origin','SecurityError');
  return url;
}
