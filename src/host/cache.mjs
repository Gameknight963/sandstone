import {CacheService} from '../cache/service.mjs';
import {iframes} from './frames.mjs';
import {rpc_handlers} from '../rpc.mjs';
import {site_data} from './site_data.mjs';

let storage,locks;
try{storage=globalThis.caches;}catch{}
try{locks=globalThis.navigator?.locks;}catch{}
export const cache_storage=new CacheService(storage,{locks,onCatalog:catalog=>site_data.cacheStorage=catalog});
rpc_handlers.cache_command=(id,command)=>{
  const frame=iframes[id],origin=frame?.origin||frame?.url?.origin;
  if(!frame||frame.broadcast_origin?.startsWith('opaque:'))throw new DOMException('Cache origin is unavailable','SecurityError');
  return cache_storage.command(id,origin,command);
};
