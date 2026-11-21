import {ctx} from './context.mjs';
import * as loader from './loader.mjs';
import * as rpc from '../rpc.mjs';
import {document_referrer_policy} from './intercept/document.mjs';
import {find_frame_target,navigate_frame_target} from './iframe_window.mjs';
import {load_cookies} from './polyfill/cookie.mjs';
import {history_hash} from './polyfill/history.mjs';
import {navigation_activation} from './user_activation.mjs';

const attribute=globalThis.Element?.prototype.getAttribute;
export function navigation_target(element,override=null){
  const own=override??attribute.call(element,'target');
  if(own)return own;
  for(const base of document.querySelectorAll('base[target]'))if(base instanceof HTMLBaseElement)return attribute.call(base,'target');
  return '';
}
export function navigate_target(url,target='',form_data=null,navigation={}){
  if(typeof target==='string'&&/[\t\n\r]/.test(target)&&target.includes('<'))target='_blank';
  const keyword=typeof target==='string'?target.toLowerCase():'';
  if(!url.startsWith('javascript:')&&(!target||keyword==='_self'||!['_parent','_top','_blank'].includes(keyword)&&target===ctx.name)){
    const next=new URL(url),current=new URL(ctx.location.href);
    if(!form_data&&next.origin===current.origin&&next.pathname===current.pathname&&next.search===current.search&&url.includes('#')){
      history_hash(ctx.history,url);return Promise.resolve();
    }
    return loader.navigate(loader.frame_id,url,true,form_data,navigation);
  }
  const activation=navigation.activation||navigation_activation();
  return rpc.call_procedure(rpc.host,'navigate_target',[loader.frame_id,loader.beacon_context,target,url,form_data,{referrerPolicy:document_referrer_policy(),...navigation,activation}]).then(result=>{
    if(result?.download)load_cookies(result.cookies);return result;
  });
}
rpc.rpc_handlers.find_navigation_target=name=>ctx.name===name?{id:loader.frame_id}:find_frame_target(name,loader.frame_id);
rpc.rpc_handlers.navigate_child_target=(id,url,form_data,navigation)=>navigate_frame_target(id,url,form_data,navigation);
export function navigate_fragment(url,replace=false){history_hash(ctx.history,url,replace);}
rpc.rpc_handlers.navigate_fragment=navigate_fragment;
