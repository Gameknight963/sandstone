import {parentPort} from 'node:worker_threads';
import {create_sync_http_client} from '../src/sync_http.mjs';
const request=create_sync_http_client({post:packet=>parentPort.postMessage(packet)});
parentPort.on('message',message=>{
  try{const response=request(message.url,message.options||{},message.timeout);parentPort.postMessage({type:'result',response});}
  catch(error){parentPort.postMessage({type:'result',error:{name:error.name,message:error.message}});}
});
