import {iframes} from './frames.mjs';
import * as rpc from '../rpc.mjs';
import {beacons} from './network.mjs';

const origin=frame=>frame.broadcast_origin||frame.origin||frame.url?.origin||'opaque:'+frame.id;
function current(frame,token){const context=beacons.contexts.get(token);return !!context&&context.frame===frame.id&&iframes[frame.id]===frame&&frame.document_context===token&&!context.retired;}

export async function navigate_javascript(source,target,url){
  const source_token=source.document_context,target_token=target.document_context;
  if(source.worker||target.worker||source.root_id!==target.root_id||!current(source,source_token)||!current(target,target_token)||origin(source)!==origin(target))return {no_navigation:true};
  const root=iframes[target.root_id],port=target.id===root?.id?root.rpc_target.target:root?.rpc_target.extra_frame_targets.get(target.id);
  if(!port)return {no_navigation:true};
  const navigation_id=target.navigation_id,pending=target.pending_navigation;
  const result=await rpc.call_procedure(port,'javascript_url',[url,target_token]);
  if(!current(source,source_token)||!current(target,target_token))return {no_navigation:true};
  if(typeof result?.html==='string'){
    if(target.navigation_id!==navigation_id||target.pending_navigation!==pending)return {no_navigation:true};
    const blank=target.url.protocol==='about:'&&target.url.pathname==='blank';
    const replacement={...result.document,html:result.html,document_origin:target.document_origin??target.origin,broadcast_origin:target.broadcast_origin,cookie_url:blank?'about:blank':target.cookie_url,creator_url:target.request_url||target.cookie_url||target.url.href,referrer_url:target.referrer_url};
    await target.navigate_to(target.url.href,null,{history_mode:'replace',result_document:true},replacement);
    return {no_navigation:true,executed:true,replaced:true};
  }
  return {no_navigation:true,...result};
}
