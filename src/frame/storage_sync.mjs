import * as rpc from '../rpc.mjs';
import * as loader from './loader.mjs';
import {FakeStorage} from './polyfill/storage.mjs';
import {StorageReplica} from '../storage_replica.mjs';

let active;
const dispatch=globalThis.dispatchEvent;
const current=globalThis.Event&&Object.getOwnPropertyDescriptor(Event.prototype,'currentTarget');
const path=globalThis.Event?.prototype.composedPath;

rpc.rpc_handlers.storage_reset=(token,kind,entries)=>{
  if(active?.token===token)active[kind]?.replica.reset(entries);
};

rpc.rpc_handlers.storage_update=(token,kind,change,ack,event)=>{
  const document=active;
  if(!document||document.token!==token)return;
  const store=document[kind];
  if(!store)return;
  store.replica.update(change,ack);
  if(!event)return;
  setTimeout(()=>{
    if(active!==document)return;
    const notification=new StorageEvent('storage',event),window=document.window();
    Object.defineProperties(notification,{
      storageArea:{value:store.storage},target:{value:window},
      currentTarget:{get(){const target=current.get.call(this);return target===globalThis?window:target;}},
      composedPath:{value(){return path.call(this).map(target=>target===globalThis?window:target);}}
    });
    dispatch.call(globalThis,notification);
  },0);
};

export function create_document_storage(options,url,window){
  const id=loader.frame_id,token=loader.beacon_context;
  if(active?.token)rpc.call_procedure(rpc.host,'storage_disconnect',[id,active.token]).catch(()=>{});
  const document=active={token,window};
  for(const kind of ['local','session']){
    const entries=options[kind+'_storage'];
    let replica;
    const storage=new FakeStorage(entries,(_snapshot,change)=>replica.write(change));
    replica=new StorageReplica(entries,{
      replace:entries=>storage._replace_entries(entries),
      submit:change=>rpc.call_procedure(rpc.host,kind+'_storage',[id,undefined,{...change,context:token,url:url()}]).catch(console.error)
    });
    document[kind]={storage,replica};
  }
  const ready=token?rpc.call_procedure(rpc.host,'storage_ready',[id,token]).then(snapshot=>{
    if(active!==document)return snapshot;
    if(!snapshot.opaque)for(const kind of ['local','session'])document[kind].replica.reset(snapshot[kind]);
    return snapshot;
  }):Promise.resolve({opaque:new URL(options.url).origin==='null'});
  globalThis.addEventListener('unload',()=>{
    if(active===document)active=undefined;
    rpc.call_procedure(rpc.host,'storage_disconnect',[id,token]).catch(()=>{});
  },{once:true});
  return {local:document.local.storage,session:document.session.storage,ready};
}
