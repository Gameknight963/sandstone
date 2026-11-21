import {ctx,convert_url} from '../context.mjs';
import * as loader from '../loader.mjs';
import {unwrap_global_target,unwrap_global_function} from '../global_functions.mjs';
import {virtual_frame_window,frame_window_state} from '../iframe_window.mjs';
import {message_peer_window} from '../window_messages.mjs';
import {navigate_target} from '../navigation_targets.mjs';
import {document_referrer_policy} from './document.mjs';
import {window_features} from '../../window_features.mjs';

const native=globalThis.Window&&globalThis.open;
const window_get=native&&Object.getOwnPropertyDescriptor(globalThis,'window').get;
const well_formed=String.prototype.toWellFormed;
let adapter;
export function default_open(){return adapter;}
export function is_default_open(){return !!adapter&&unwrap_global_function(ctx.window.open)===adapter;}
export function open_from_context(receiver,args){return Reflect.apply(adapter,receiver,args);}
export function frame_open_method(target,alias){return new Proxy(native,{apply(_method,receiver,args){return open_from_context(receiver===alias||receiver===undefined||receiver===null?target:receiver,args);}});}
if(native)globalThis.open=adapter=new Proxy(native,{apply(_method,receiver,args){
  receiver=unwrap_global_target(receiver??globalThis);
  window_get.call(receiver); // Preserve native Window receiver validation.
  const peer=receiver!==globalThis?frame_window_state(receiver):null;
  if(receiver!==globalThis&&(!peer||peer.opaque()||peer.origin()!==ctx.origin))throw new DOMException('Blocked access to a cross-origin window','SecurityError');
  let url=args[0]===undefined?'':`${args[0]}`;
  const target=args[1]===undefined?'_blank':`${args[1]}`,features=args[2]===undefined?'':`${args[2]}`;
  if(well_formed)url=well_formed.call(url);
  if(url)try{url=convert_url(url,ctx.document.baseURI,loader.character_encoding);}catch{throw new DOMException('Invalid window URL','SyntaxError');}
  const flags=window_features(features),keyword=target.toLowerCase();
  if(!target||keyword==='_blank'||/[\t\n\r]/.test(target)&&target.includes('<'))return null;
  const navigation={referrerPolicy:flags.noreferrer?'no-referrer':document_referrer_policy()};
  let destination,navigate=()=>navigate_target(url,target,null,navigation);
  if(keyword==='_self'){
    destination=peer?peer.window:ctx.window;
    if(peer)navigate=()=>peer.navigate(url,'push',null,navigation);
  }
  else if(keyword==='_parent'){
    destination=peer?ctx.window:ctx.parent;
    if(peer)navigate=()=>navigate_target(url,'_self',null,navigation);
  }
  else if(keyword==='_top')destination=ctx.top;
  else{
    // noopener names select a new auxiliary context, not an existing frame.
    if(flags.noopener)return null;
    if(!peer&&target===ctx.name)destination=ctx.window;
    else{
      // Let the browser select its familiar named context, but never give it
      // a remote URL. Unknown/new contexts remain blocked by the sandbox.
      const selected=Reflect.apply(native,receiver,['',target,'']);
      if(!selected)return null;
      destination=virtual_frame_window(selected);
      if(destination===selected)destination=message_peer_window(selected);
      if(!destination)return null;
    }
  }
  if(url)navigate().catch(console.error);
  return destination;
}});
