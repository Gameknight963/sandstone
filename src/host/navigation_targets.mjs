import {iframes} from './frames.mjs';
import {frame_cross_site} from './frame_context.mjs';
import {site_data} from './site_data.mjs';
import * as rpc from '../rpc.mjs';
import {can_navigate} from '../navigation_policy.mjs';
import {beacons} from './network.mjs';
import {navigate_javascript} from './javascript_navigation.mjs';

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
  const context={url:source.request_url||source.url.href,top_url:root.url.href,cross_site:frame_cross_site(source,iframes),broadcast_origin:source.broadcast_origin,document:token,frame:id};
  navigation={...navigation,initiated:true,source_frame_id:id,source_context:context};
  const keyword=typeof name==='string'?name.toLowerCase():'';
  let destination;
  if(name&&typeof name==='object'){
    // Window method receivers select an existing context independently of its
    // name. Apply the same root and navigation checks as named destinations.
    let selected=typeof name.id==='string'&&iframes[name.id];
    if(!selected||selected.root_id!==root.id||selected.worker)return;
    const depth=name.parent?1:name.ancestor??0;
    if(!Number.isSafeInteger(depth)||depth<0)return;
    const visited=new Set([selected.id]);
    for(let step=0;step<depth&&selected.parent_id;step++){
      selected=iframes[selected.parent_id];
      if(!selected||selected.root_id!==root.id||visited.has(selected.id))return;
      visited.add(selected.id);
    }
    destination={id:selected.id};
  }
  else if(!name||keyword==='_self')destination={id};
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
  if(next.protocol==='javascript:')return frame?navigate_javascript(source,frame,url):{no_navigation:true};
  let result;
  if(frame&&current&&next.href.split('#')[0]===current.href.split('#')[0]&&url.includes('#')&&!form_data&&navigation.history_mode!=='reload'){
    const target=port(frame);
    if(target)result=await rpc.call_procedure(target,'navigate_fragment',[url,navigation.history_mode==='replace']);
  }else if(destination.parent){
    const parent=iframes[destination.parent],target=parent&&port(parent);
    if(parent?.root_id!==root.id||!target)return;
    result=await rpc.call_procedure(target,'navigate_child_target',[destination.id,url,form_data,navigation]);
  }else if(frame?.root_id===root.id)result=await frame.navigate_to(url,form_data,navigation);
  if(result?.download)return {...result,cookies:site_data.documentCookies(context.url,{crossSite:context.cross_site})};
  return result;
};
