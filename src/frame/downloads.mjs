import * as rpc from '../rpc.mjs';
import * as loader from './loader.mjs';
import * as network from './network.mjs';
import {download_filename} from '../download.mjs';
import {load_cookies} from './polyfill/cookie.mjs';

const request=rpc.create_rpc_wrapper(rpc.host,'download_request');
const save=rpc.create_rpc_wrapper(rpc.host,'download_blob');

export function capture_download(url,hint){
  const context=loader.beacon_context,pending=network.fetch(url);pending.catch(()=>{});
  return async()=>{const response=await pending;return save(context,await response.blob(),download_filename(url,null,hint));};
}

export async function download(url,hint,options={}) {
  const context=loader.beacon_context;
  if(/^https?:/.test(url)){
    const result=await request(context,url,hint,options);load_cookies(result.cookies);return result.filename;
  }
  return capture_download(url,hint)();
}

export async function save_response(response,hint) {
  if(!response.ok){await response.body?.cancel();throw new TypeError('Download failed: '+response.status);}
  const context=loader.beacon_context;
  return save(context,await response.blob(),download_filename(response.url,response.headers.get('content-disposition'),hint));
}
