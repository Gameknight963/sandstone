import * as loader from './loader.mjs';
import * as rpc from '../rpc.mjs';
import {create_service_worker} from './polyfill/worker.mjs';
import {ServiceWorkerBridge} from '../service_worker/bridge.mjs';
let bridge;
function authorize(){if(!loader.service_worker_host)throw new DOMException('Not a service worker owner','SecurityError');}
rpc.rpc_handlers.service_worker_start=async(profile,timeout)=>{
  authorize();if(bridge)throw new DOMException('Service worker owner is already running','InvalidStateError');
  const worker=create_service_worker(profile);
  bridge=new ServiceWorkerBridge({timeout,post:(packet,ports)=>worker.postMessage(packet,ports),terminate:()=>worker.terminate(),
    command:(method,args)=>rpc.call_procedure(rpc.host,'service_worker_command',[loader.frame_id,method,args])});
  worker.onmessage=event=>bridge.accept(event.data);
  worker.onerror=event=>{event.preventDefault();bridge.close(event.error||new Error(event.message));};
  await bridge.ready;
};
rpc.rpc_handlers.service_worker_control=(method,...args)=>{
  authorize();if(!bridge)throw new DOMException('Service worker owner is not running','InvalidStateError');
  if(!['dispatch','wait','read','cancel','handled','release','close','scripts'].includes(method))throw new TypeError('Unknown service worker owner operation');
  return bridge[method](...args);
};
