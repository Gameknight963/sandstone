import {RPCSourcePolicy} from './rpc_policy.mjs';

const procedures=new Set(['fetch','fetch_read','fetch_abort','idb_command','idb_poll','idb_databases','cache_command','crypto','ws_new','ws_event','ws_send','ws_close','fetch_keepalive','fetch_keepalive_read','fetch_keepalive_abort','fetch_keepalive_done','broadcast_open','broadcast_command','lock_open','lock_query','filesystem_command']);
const denied=()=>{throw new DOMException('Worker RPC source is not authorized','SecurityError');};

export class WorkerRPCPolicy extends RPCSourcePolicy {
  authorize(message,source){
    if(!procedures.has(message?.procedure))denied();
    if(message.procedure==='fetch'){
      const options=message.arguments?.[3];
      if(options?.mode==='navigate'||options?.sandstone_navigation_target||options?.sandstone_navigation_activation||options?.sandstone_worker_entry||options?.sandstone_request_context||message.arguments?.[4])denied();
    }
    return super.authorize(message,source);
  }
}
