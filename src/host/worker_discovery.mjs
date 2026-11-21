import {create_bootstrap_nonce} from '../bootstrap.mjs';

export const owner_prefix='sandstone.backend-owner.v1:';
const live_name=key=>key+':live',channel_name=key=>key+':discover';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
export const backend_gone=()=>new DOMException('Shared worker backend is unavailable','AbortError');

export async function hold_lock(name,{ifAvailable=false,locks=globalThis.navigator?.locks}={}){
  if(typeof locks?.request!=='function')throw new DOMException('Worker backend discovery requires Web Locks','NotSupportedError');
  const granted=deferred(),released=deferred(),controller=new AbortController();
  locks.request(name,ifAvailable?{ifAvailable:true}:{signal:controller.signal},async lock=>{
    if(!lock){granted.resolve(null);return;}
    let closed=false;
    granted.resolve({name,close(){if(closed)return;closed=true;released.resolve();controller.abort();}});
    await released.promise;
  }).catch(granted.reject);
  return granted.promise;
}

export function watch_backend(key,close,{locks=globalThis.navigator?.locks}={}){
  const controller=new AbortController();
  locks.request(live_name(key),{signal:controller.signal},()=>close(backend_gone())).catch(error=>{if(!controller.signal.aborted)close(error);});
  return ()=>controller.abort();
}

// Listen before taking the lease: a discovering UI may observe the new lease
// immediately, even if its creator disappears before receiving the reply.
export async function publish_backend(key,descriptor,{locks=globalThis.navigator?.locks,Channel=globalThis.BroadcastChannel}={}){
  const channel=new Channel(channel_name(key)),waiting=new Set();let lease;
  channel.onmessage=event=>{
    const message=event.data;if(message?.type!=='discover'||typeof message.nonce!=='string')return;
    if(lease)channel.postMessage({type:'backend',nonce:message.nonce,descriptor});else waiting.add(message.nonce);
  };
  try{
    lease=await hold_lock(live_name(key),{ifAvailable:true,locks});
    if(!lease){channel.close();return null;}
    for(const nonce of waiting)channel.postMessage({type:'backend',nonce,descriptor});waiting.clear();
    return {close(){channel.close();lease.close();}};
  }catch(error){channel.close();lease?.close();throw error;}
}

export async function backend_live(key,{locks=globalThis.navigator?.locks}={}){
  return locks.request(live_name(key),{ifAvailable:true},lock=>!lock);
}

export async function find_backend(key,{locks=globalThis.navigator?.locks,Channel=globalThis.BroadcastChannel}={}){
  const channel=new Channel(channel_name(key)),answer=deferred(),nonce=create_bootstrap_nonce(),controller=new AbortController();
  channel.onmessage=event=>{
    const message=event.data;if(message?.type==='backend'&&message.nonce===nonce)answer.resolve(message.descriptor);
  };
  try{
    if(!await backend_live(key,{locks}))return null;
    const ended=locks.request(live_name(key),{signal:controller.signal},()=>null);
    channel.postMessage({type:'discover',nonce});
    return await Promise.race([answer.promise,ended]);
  }finally{controller.abort();channel.close();}
}
