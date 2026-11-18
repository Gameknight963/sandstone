import * as loader from '../loader.mjs';
import * as rpc from '../../rpc.mjs';
import {create_cache_api} from '../../cache/client.mjs';
import {fetch,FakeRequest} from './fetch.mjs';

const command=rpc.create_rpc_wrapper(rpc.host,'cache_command');
export const {caches,Cache,CacheStorage}=create_cache_api({command:value=>command(loader.frame_id,value),fetch,Request:FakeRequest});
