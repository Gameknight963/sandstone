import {FileService} from '../filesystem/service.mjs';
import {beacons} from './network.mjs';
import {rpc_handlers} from '../rpc.mjs';
import {site_data} from './site_data.mjs';
import {estimate_storage} from '../filesystem/estimate.mjs';
let factory,manager;
try{factory=globalThis.indexedDB;}catch{}
try{manager=globalThis.navigator?.storage;}catch{}
export const file_system=new FileService(factory,{onCatalog:catalog=>site_data.fileSystems=catalog});
rpc_handlers.filesystem_command=async(token,command)=>{
  const entry=beacons.contexts.get(token);if(!entry||entry.retired||entry.cleared_storage?.fileSystems)throw new DOMException('File document is unavailable','InvalidStateError');
  const context=entry.context,origin=context.broadcast_origin||new URL(context.url).origin;
  if(origin==='null'||origin.startsWith('opaque:'))throw new DOMException('File origin is unavailable','SecurityError');
  if(command?.op==='estimate'){
    const catalog=await file_system.storage.catalog(),usage=catalog.find(info=>info.origin===origin)?.usage||0;
    let quota=512*1024*1024;if(file_system.storage.persistent)try{quota=(await manager?.estimate())?.quota||quota;}catch{}
    return estimate_storage(origin,site_data,usage,quota);
  }
  if(command?.op==='persisted'||command?.op==='persist'){
    await file_system.storage.ready;if(!file_system.storage.persistent)return false;
    try{return !!await manager?.[command.op]();}catch{return false;}
  }
  try{return await file_system.command(origin,token,command);}
  finally{if(entry.retired)file_system.release(token);}
};
