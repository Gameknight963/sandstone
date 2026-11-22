import source from '../../dist/sandstone_shared_backend.js';
import {create_bootstrap_nonce} from '../bootstrap.mjs';
import {libcurl_binary} from './libcurl_wasm.mjs';
import {version} from './version.mjs';
import {owner_prefix,hold_lock,watch_backend,find_backend,backend_live,backend_gone} from './worker_discovery.mjs';
import {crypto_service} from './crypto.mjs';
import {delegate as create_owner_delegate} from './shared_owner.mjs';

const NativeSharedWorker=globalThis.SharedWorker;
const unavailable=()=>new DOMException('Worker backend connection is closed','InvalidStateError');
const owner_delegates=new WeakMap();
export function register_owners(connection){
  if(owner_delegates.has(connection))return owner_delegates.get(connection);
  const registering=(async()=>{
    const delegate=await create_owner_delegate();
    try{
      const value=await connection.request('actor-ui',{lease:delegate.lease},[delegate.port]);
      connection.closed.then(()=>delegate.close());return {...value,close:()=>delegate.close()};
    }catch(error){delegate.close();throw error;}
  })();
  owner_delegates.set(connection,registering);registering.catch(()=>{if(owner_delegates.get(connection)===registering)owner_delegates.delete(connection);});return registering;
}

export async function share_crypto(connection){
  const detach=crypto_service.setVault({
    store:records=>connection.request('keys-store',{records}),
    load:handles=>connection.request('keys-load',{handles})
  });
  connection.closed.then(detach);
  try{await crypto_service.publish_keys();return detach;}
  catch(error){detach();throw error;}
}

// These URLs and ports are private host capabilities. Never pass them to a
// renderer; its remote worker receives only its restricted service port.
export async function connect(url,{name,websocket,binary,signal}={}){
  signal?.throwIfAborted();
  if(!['http:','https:'].includes(globalThis.location?.protocol)||!NativeSharedWorker)throw new DOMException('Shared worker backends require a hosted page','NotSupportedError');
  if(typeof name!=='string'||!name)throw new TypeError('A private worker backend name is required');
  const worker=new NativeSharedWorker(url,{name}),pending=new Map(),events=new EventTarget();let sequence=0,closed=false,resolveClosed;
  const ended=new Promise(resolve=>{resolveClosed=resolve;});
  const close=(error=unavailable())=>{
    if(closed)return;closed=true;
    worker.port.removeEventListener('message',receive);worker.removeEventListener('error',failed);worker.port.close();
    signal?.removeEventListener('abort',abort);
    for(const call of pending.values())call.reject(error);pending.clear();resolveClosed(error);
  };
  const abort=()=>close(signal.reason);
  const failed=event=>close(new Error(event.message||'Worker backend failed'));
  const receive=event=>{
    const reply=event.data;
    if(reply?.type==='bridge-error'||reply?.type==='actor-error'){events.dispatchEvent(new MessageEvent(reply.type,{data:reply}));return;}
    const call=pending.get(reply?.id);if(!call)return;
    pending.delete(reply.id);
    if(reply.ok===true)call.resolve(event.ports.length?{...reply.value,ports:event.ports}:reply.value);
    else{const error=new Error(reply.error?.message||'Worker backend request failed');error.name=reply.error?.name||'Error';call.reject(error);}
  };
  const request=(op,message={},transfer=[])=>new Promise((resolve,reject)=>{
    if(closed){reject(unavailable());return;}
    const id=++sequence;pending.set(id,{resolve,reject});
    try{worker.port.postMessage({...message,op,id},transfer);}
    catch(error){pending.delete(id);reject(error);}
  });
  worker.port.addEventListener('message',receive);worker.addEventListener('error',failed);worker.port.start();
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  try{
    const profile=await request('initialize',{websocket,binary});
    return {url,name,...profile,request,close,events,closed:ended,get isClosed(){return closed;}};
  }catch(error){close(error);throw error;}
}

const connections=new Map();
export async function get({websocket}={}){
  if(!['http:','https:'].includes(globalThis.location?.protocol)||!NativeSharedWorker||typeof navigator.locks?.request!=='function'||typeof BroadcastChannel!=='function'||!crypto.subtle)throw new DOMException('Shared worker discovery is unavailable','NotSupportedError');
  const relay=new URL(websocket);
  if(!['ws:','wss:'].includes(relay.protocol)||relay.username||relay.password||relay.hash)throw new TypeError('A relay WebSocket URL is required');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([version.ver,version.hash,relay.href])));
  const key='sandstone.shared-backend.v1:'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  if(connections.has(key))return connections.get(key);
  const pending=join_backend(key,relay.href);connections.set(key,pending);
  const forget=()=>{if(connections.get(key)===pending)connections.delete(key);};
  pending.then(connection=>connection.closed.then(forget),forget);return pending;
}

async function join_backend(key,websocket){
  const owner=await hold_lock(owner_prefix+create_bootstrap_nonce());
  try{
    return await navigator.locks.request(key+':create',async()=>{
      for(;;){
        const descriptor=await find_backend(key);let connection,stop;
        try{
          if(descriptor){
            const target=new URL(descriptor.url);
            if(target.protocol!=='blob:'||target.origin!==location.origin||typeof descriptor.name!=='string')throw new DOMException('Invalid private backend descriptor','SecurityError');
            const lifetime=new AbortController();stop=watch_backend(key,error=>lifetime.abort(error));
            connection=await connect(target.href,{name:descriptor.name,websocket,signal:lifetime.signal});
            if(connection.identity!==descriptor.identity)throw backend_gone();
            await connection.request('owner',{lease:owner.name});
          }else{
            connection=await create({websocket});
            if(!await connection.request('publish',{key,lease:owner.name})){
              await connection.request('shutdown');connection.close();connection.revoke();continue;
            }
            stop=watch_backend(key,error=>connection.close(error));
          }
          const originalClose=connection.close;
          connection.close=error=>{originalClose(error);owner.close();};
          connection.closed.then(()=>{stop();owner.close();connection.revoke?.();});
          return connection;
        }catch(error){
          stop?.();connection?.close();connection?.revoke?.();
          if(descriptor&&(error.name==='AbortError'||!await backend_live(key)))continue;
          throw error;
        }
      }
    });
  }catch(error){owner.close();throw error;}
}

export async function create({websocket}={}){
  if(!['http:','https:'].includes(globalThis.location?.protocol)||!NativeSharedWorker)throw new DOMException('Shared worker backends require a hosted page','NotSupportedError');
  const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
  try{
    const connection=await connect(url,{name:'sandstone.backend:'+create_bootstrap_nonce(),websocket,binary:libcurl_binary()});
    connection.revoke=()=>URL.revokeObjectURL(url);return connection;
  }catch(error){URL.revokeObjectURL(url);throw error;}
}
