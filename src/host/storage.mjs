import {iframes} from './controller.mjs';
import {site_data} from './site_data.mjs';
import {beacons} from './network.mjs';
import {apply_storage_change} from '../storage_changes.mjs';
import * as rpc from '../rpc.mjs';

const clients=new Map();
let committingLocal=false;
function notify(id,client,procedure,args){
  const root=iframes[client.root],port=id===client.root?root?.rpc_target.target:root?.rpc_target.extra_frame_targets.get(id);
  if(!port){clients.delete(id);return;}
  try{rpc.notify(port,procedure,args);}catch{clients.delete(id);}
}
site_data.localListeners.add((origin,entries)=>{
  if(committingLocal)return;
  for(const [id,client] of clients)if(client.origin===origin)notify(id,client,'storage_reset',[client.token,'local',entries]);
});
export function disconnect_storage(id,token){if(token===undefined||clients.get(id)?.token===token)clients.delete(id);}
rpc.rpc_handlers.storage_disconnect=(id,token)=>{if(typeof token==='string')disconnect_storage(id,token);};
rpc.rpc_handlers.storage_ready=(id,token)=>{
  const frame=iframes[id],context=beacons.contexts.get(token);
  if(!frame||!context||context.frame!==id||context.retired)throw new DOMException('Storage document is unavailable','InvalidStateError');
  const origin=frame.origin||frame.url.origin;
  if(origin==='null'||frame.broadcast_origin?.startsWith('opaque:'))return {opaque:true};
  context.storage={origin,root:frame.root_id,session:frame.session_storage,url:frame.url.href};
  clients.set(id,{token,origin,root:frame.root_id});
  return {local:site_data.local[origin]||[],session:frame.session_storage[origin]||[]};
};

function mutate(id,_entries,change,kind){
  const context=beacons.contexts.get(change?.context);
  if(!context||context.frame!==id||!context.storage)return;
  // The document token is required: a reusable frame ID cannot authorize writes
  // to its new destination. Retiring documents retain their original area.
  const source=context.storage;
  const {origin}=source;
  const previous=kind==='local'?site_data.local[origin]:source.session[origin];
  const next=apply_storage_change(previous,change);
  if(kind==='local'){
    committingLocal=true;
    try{site_data.setLocal(origin,next);}finally{committingLocal=false;}
  }else source.session[origin]=next;
  const before=new Map(previous||[]),key=change.type==='clear'?null:change.key;
  const oldValue=key===null?null:before.get(key)??null;
  const newValue=change.type==='set'?change.value:null;
  const changed=key===null?before.size>0:oldValue!==newValue;
  let url=source.url;
  try{if(new URL(change.url).origin===origin)url=new URL(change.url).href;}catch{}
  for(const [peerId,peer] of clients){
    if(peer.origin!==origin||(kind==='session'&&peer.root!==source.root))continue;
    const owner=peerId===id&&peer.token===change.context;
    if(!owner&&!changed)continue;
    const event=owner?undefined:{key,oldValue,newValue,url};
    notify(peerId,peer,'storage_update',[peer.token,kind,change,owner?change.id:undefined,event]);
  }
}
rpc.rpc_handlers.local_storage=(id,entries,change)=>mutate(id,entries,change,'local');
rpc.rpc_handlers.session_storage=(id,entries,change)=>mutate(id,entries,change,'session');
