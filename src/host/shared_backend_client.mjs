import source from '../../dist/sandstone_shared_backend.js';
import {create_bootstrap_nonce} from '../bootstrap.mjs';
import {libcurl_binary} from './libcurl_wasm.mjs';

const NativeSharedWorker=globalThis.SharedWorker;
const unavailable=()=>new DOMException('Worker backend connection is closed','InvalidStateError');

// These URLs and ports are private host capabilities. Never pass them to a
// renderer; its remote worker receives only its restricted service port.
export async function connect(url,{name,websocket,binary}={}){
  if(!['http:','https:'].includes(globalThis.location?.protocol)||!NativeSharedWorker)throw new DOMException('Shared worker backends require a hosted page','NotSupportedError');
  if(typeof name!=='string'||!name)throw new TypeError('A private worker backend name is required');
  const worker=new NativeSharedWorker(url,{name}),pending=new Map();let sequence=0,closed=false;
  const close=(error=unavailable())=>{
    if(closed)return;closed=true;
    worker.port.removeEventListener('message',receive);worker.removeEventListener('error',failed);worker.port.close();
    for(const call of pending.values())call.reject(error);pending.clear();
  };
  const failed=event=>close(new Error(event.message||'Worker backend failed'));
  const receive=event=>{
    const reply=event.data,call=pending.get(reply?.id);if(!call)return;
    pending.delete(reply.id);
    if(reply.ok===true)call.resolve(reply.value);
    else{const error=new Error(reply.error?.message||'Worker backend request failed');error.name=reply.error?.name||'Error';call.reject(error);}
  };
  const request=(op,message={},transfer=[])=>new Promise((resolve,reject)=>{
    if(closed){reject(unavailable());return;}
    const id=++sequence;pending.set(id,{resolve,reject});
    try{worker.port.postMessage({...message,op,id},transfer);}
    catch(error){pending.delete(id);reject(error);}
  });
  worker.port.addEventListener('message',receive);worker.addEventListener('error',failed);worker.port.start();
  try{
    const profile=await request('initialize',{websocket,binary});
    return {url,name,...profile,request,close};
  }catch(error){close(error);throw error;}
}

export async function create({websocket}={}){
  if(!['http:','https:'].includes(globalThis.location?.protocol)||!NativeSharedWorker)throw new DOMException('Shared worker backends require a hosted page','NotSupportedError');
  const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
  try{
    const connection=await connect(url,{name:'sandstone.backend:'+create_bootstrap_nonce(),websocket,binary:libcurl_binary()});
    return {...connection,revoke(){URL.revokeObjectURL(url);}};
  }catch(error){URL.revokeObjectURL(url);throw error;}
}
