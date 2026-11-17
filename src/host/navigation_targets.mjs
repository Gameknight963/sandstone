import {iframes} from './controller.mjs';
import {frame_cross_site} from './frame_context.mjs';
import {site_data} from './site_data.mjs';
import * as rpc from '../rpc.mjs';
import {can_navigate} from '../navigation_policy.mjs';
import {beacons} from './network.mjs';

function port(frame){
  const root=iframes[frame.root_id];
  return frame.id===frame.root_id?root?.rpc_target.target:root?.rpc_target.extra_frame_targets.get(frame.id);
}
async function find(frame,name){
  const target=port(frame);if(!target)return null;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new DOMException('Target lookup timed out','TimeoutError')),5000);
  try{return await rpc.call_procedure(target,'find_navigation_target',[name],{signal:controller.signal});}
  finally{clearTimeout(timer);}
}
rpc.rpc_handlers.navigate_target=async(id,token,name,url,form_data,navigation={})=>{
  const source=iframes[id],document=beacons.contexts.get(token);
  if(!source||!document||document.frame!==id||document.retired)return;
  const root=iframes[source.root_id];if(!root)return;
  const context={url:source.url.href,top_url:root.url.href,cross_site:frame_cross_site(source,iframes),broadcast_origin:source.broadcast_origin};
  navigation={...navigation,initiated:true,source_frame_id:id,source_context:context};
  const keyword=name.toLowerCase();
  let destination;
  if(!name||keyword==='_self')destination={id};
  else if(keyword==='_parent')destination={id:source.parent_id||id};
  else if(keyword==='_top')destination={id:source.root_id};
  else if(keyword!=='_blank'){
    // Ask each document for live native frame order, including blank children
    // which have no host registration until their first relayed navigation.
    const documents=[source,root,...Object.values(iframes).filter(frame=>frame.root_id===root.id&&!frame.worker)];
    const visited=new Set();
    for(const frame of documents){
      if(visited.has(frame.id)||iframes[frame.id]!==frame)continue;
      visited.add(frame.id);
      destination=await find(frame,name);
      if(document.retired||iframes[id]!==source)return;
      if(destination)break;
    }
  }
  // Auxiliary windows still use the current virtual surface; never let the
  // browser follow a new target directly to the remote HTTP URL.
  destination??={id};
  if(document.retired||iframes[id]!==source)return;
  const frame=iframes[destination.id];
  const targetFrame=frame||{id:destination.id,parent_id:destination.parent,root_id:root.id,origin:iframes[destination.parent]?.origin};
  if(!can_navigate(source,targetFrame,iframes,navigation.activation))return;
  const next=new URL(url),current=frame?.url;
  let result;
  if(frame&&current&&next.origin===current.origin&&next.pathname===current.pathname&&next.search===current.search&&url.includes('#')&&!form_data){
    const target=port(frame);
    if(target)result=await rpc.call_procedure(target,'navigate_fragment',[url]);
  }else if(destination.parent){
    const parent=iframes[destination.parent],target=parent&&port(parent);
    if(parent?.root_id!==root.id||!target)return;
    result=await rpc.call_procedure(target,'navigate_child_target',[destination.id,url,form_data,navigation]);
  }else if(frame?.root_id===root.id)result=await frame.navigate_to(url,form_data,navigation);
  if(result?.download)return {...result,cookies:site_data.documentCookies(context.url,{crossSite:context.cross_site})};
  return result;
};
