import * as rpc from '../rpc.mjs';
import * as loader from './loader.mjs';
import {FakeStorage,install_storage_prototype,replace_storage_entries,is_virtual_storage} from './polyfill/storage.mjs';
import {StorageReplica} from '../storage_replica.mjs';
import {register_document,document_states} from './document_identity.mjs';
import {install_storage_events} from '../storage_events.mjs';
import {configure_style_mutations} from './rewrite/style.mjs';
import {cookie_document_active} from './polyfill/cookie.mjs';
import {configure_document_events} from './event_identity.mjs';
import {configure_link_events} from './link_events.mjs';
import {configure_form_submissions} from './rewrite/form.mjs';

let active;
const storage_prototype=globalThis.Storage?.prototype;
install_storage_prototype(globalThis.Storage);
if(globalThis.StorageEvent)globalThis.StorageEvent=install_storage_events(globalThis.StorageEvent,is_virtual_storage,document_states('storage-event-areas'));
export function storage_group(origin){return active?.origin===origin&&origin!=='null'?active.group:undefined;}
const dispatch=globalThis.dispatchEvent;
const current=globalThis.Event&&Object.getOwnPropertyDescriptor(Event.prototype,'currentTarget');
const path=globalThis.Event?.prototype.composedPath;
const event_phase=globalThis.Event&&Object.getOwnPropertyDescriptor(Event.prototype,'eventPhase').get;
function storage_available(document){
  // Native unload listeners run before page handlers. Keep the original views
  // usable for that dispatch, but never for later tasks or a synthetic replay.
  // Unload event phases can outlive their document; the cookie bridge probes
  // the original opaque document rather than consulting its virtual cookie jar.
  return active===document||!!document.unload_event?.isTrusted&&event_phase.call(document.unload_event)!==0&&cookie_document_active(document.native);
}

rpc.rpc_handlers.storage_reset=(token,kind,entries,revision)=>{
  if(active?.token===token)active[kind]?.replica.reset(entries,revision);
};

rpc.rpc_handlers.storage_update=(token,kind,change,ack,event,revision)=>{
  const document=active;
  if(!document||document.token!==token)return;
  const store=document[kind];
  if(!store)return;
  store.replica.update(change,ack,revision);
  if(!event)return;
  setTimeout(()=>{
    if(active!==document)return;
    const notification=new StorageEvent('storage',{...event,storageArea:store.storage}),window=document.window();
    Object.defineProperties(notification,{
      target:{value:window},
      currentTarget:{get(){const target=current.get.call(this);return target===globalThis?window:target;}},
      composedPath:{value(){return path.call(this).map(target=>target===globalThis?window:target);}}
    });
    dispatch.call(globalThis,notification);
  },0);
};

export function create_document_storage(options,url,window){
  const id=loader.frame_id,token=loader.beacon_context;
  if(active?.token){active.group.documents.delete(active.token);rpc.call_procedure(rpc.host,'storage_disconnect',[id,active.token]).catch(()=>{});}
  const origin=loader.document_origin??new URL(options.url).origin;
  let group;
  // Native SOP still bounds this lookup. Share only with an accessible parent
  // whose virtual origin matches; other frame trees continue through host sync.
  try{if(parent!==globalThis)group=parent.sandstone_frame?.storage_sync.storage_group(origin);}catch{}
  group??={token,sequence:0,documents:new Map(),areas:{},storage_brand:new WeakMap()};
  register_document(group,window().document);
  configure_document_events(group,window());
  configure_link_events();
  configure_form_submissions();
  configure_style_mutations();
  const document=active={token,window,origin,group,native:globalThis.document,send:(kind,change)=>rpc.call_procedure(rpc.host,kind+'_storage',[id,undefined,change]).catch(console.error)};
  group.documents.set(token,document);
  for(const kind of ['local','session']){
    const entries=options[kind+'_storage'];
    const storage=new FakeStorage(entries,(_snapshot,change)=>{
      replica.write({...change,context:token,url:url(),group:group.token,order:++group.sequence},operation=>document.send(kind,operation));
    },()=>{if(!storage_available(document))throw new DOMException('Storage document is unavailable','SecurityError');},{prototype:storage_prototype,registry:group.storage_brand});
    const replica=group.areas[kind]??=new StorageReplica(entries,{
      replace:entries=>{for(const peer of group.documents.values())if(peer[kind])replace_storage_entries(peer[kind].storage,entries);},
      submit:()=>{}
    });
    document[kind]={storage,replica};
  }
  for(const kind of ['local','session'])document[kind].replica.refresh();
  const ready=token?rpc.call_procedure(rpc.host,'storage_ready',[id,token]).then(snapshot=>{
    if(active!==document)return snapshot;
    if(!snapshot.opaque)for(const kind of ['local','session'])document[kind].replica.reset(snapshot[kind],snapshot.revisions?.[kind]);
    return snapshot;
  }):Promise.resolve({opaque:new URL(options.url).origin==='null'});
  on_document_unload(event=>{
    document.unload_event=event;
    if(active===document)active=undefined;
    group.documents.delete(token);
    rpc.call_procedure(rpc.host,'storage_disconnect',[id,token]).catch(()=>{});
  });
  return {local:document.local.storage,session:document.session.storage,ready};
}
import {on_document_unload} from './runtime_events.mjs';
