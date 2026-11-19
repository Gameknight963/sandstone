import {listen_runtime,on_document_unload} from './runtime_events.mjs';

const prototype=globalThis.HTMLMediaElement?.prototype;
const native=prototype&&Object.fromEntries(['play','pause','load'].map(key=>[key,prototype[key]]));
const source=prototype&&Object.getOwnPropertyDescriptor(prototype,'src');
const pending=new WeakMap();
const preparation=new WeakMap();
const MediaSource=globalThis.MediaSource;
const is_prototype=Object.prototype.isPrototypeOf;
const urls=new Set();
on_document_unload(()=>{for(const url of urls)URL.revokeObjectURL(url);urls.clear();});
export function release_media_url(url){urls.delete(url);URL.revokeObjectURL(url);}
function release(token){if(token.url)release_media_url(token.url);}
export function pending_media_url(){
  if(!MediaSource)return;
  const url=URL.createObjectURL(new MediaSource());urls.add(url);return url;
}
export function prepare_media_playback(element,prepare){preparation.set(element,prepare);}
const listeners=new WeakSet(),seen=new WeakSet();
function playback_event(event){
  if(!event.isTrusted||seen.has(event))return;
  seen.add(event);
  const token=pending.get(event.target);if(!token)return;
  const type=event.type;
  if(token.swapping&&(type==='abort'||type==='emptied'||type==='play'&&token.plays||type==='loadstart'&&token.loads)){
    event.stopImmediatePropagation();return;
  }
  if(type==='play')token.plays++;
  if(type==='loadstart')token.loads++;
  if(type==='playing'||type==='error')token.swapping=false;
}
const event_types=['play','loadstart','abort','emptied','playing','error'];
if(prototype)for(const type of event_types)listen_runtime(globalThis,type,playback_event,true);

// An invalid data URL rejects play() before the relay has delivered any bytes.
// A native, empty MediaSource keeps the browser's playback promises and state
// pending instead, including its ordinary pause/load cancellation behavior.
export function begin_media_playback(element,children=false){
  const previous=pending.get(element);
  if(children&&previous?.children)return previous;
  cancel_media_playback(element);
  if(!prototype||!is_prototype.call(prototype,element)||!children&&!MediaSource)return;
  const token={element,url:children?null:pending_media_url(),children,phase:'waiting',epoch:0,serial:0,plays:0,loads:0,swapping:false,intent:false};
  pending.set(element,token);
  if(!listeners.has(element)){
    listeners.add(element);
    for(const type of event_types)listen_runtime(element,type,playback_event,true);
  }
  return token;
}
export function cancel_media_playback(element){
  const token=pending.get(element);if(!token)return;
  pending.delete(element);token.epoch++;release(token);
}
export function finish_media_playback(token){
  if(!token||pending.get(token.element)!==token)return;
  token.phase='committed';token.serial++;token.swapping=true;release(token);
}
export function load_media_sources(element,token){
  if(!token||pending.get(element)!==token)return;
  finish_media_playback(token);native.load.call(element);
}
if(prototype){
  prototype.play=new Proxy(native.play,{apply(target,element,args){
    preparation.get(element)?.('play');
    const token=pending.get(element),epoch=token?.epoch;
    if(token?.phase==='committed'&&!token.intent)token.plays=0;
    const serial=token?.serial;
    const result=Reflect.apply(target,element,args);
    if(token)token.intent=true;
    if(!token||!token.children&&token.phase!=='waiting')return result;
    const follow=(result,serial)=>result.catch(error=>{
      // Each internal source selection may advance to another pending fallback.
      // Authored pause/load/src changes still retain their native rejection.
      if(error.name==='AbortError'&&pending.get(element)===token&&token.epoch===epoch&&token.serial!==serial){
        const next=token.serial;return follow(Reflect.apply(target,element,args),next);
      }
      throw error;
    });
    return follow(result,serial);
  }});
  for(const key of ['pause','load'])prototype[key]=new Proxy(native[key],{apply(target,element,args){
    if(key==='load')preparation.get(element)?.('load');
    const token=pending.get(element);
    if(token){
      token.epoch++;token.swapping=false;token.intent=false;
      if(key==='load'){
        token.plays=0;token.loads=0;
        // A MediaSource detached by load() cannot be opened a second time.
        // Give this new playback attempt its own native pending source.
        if(!token.children&&token.phase==='waiting'){
          release(token);token.url=pending_media_url();
          token.onURL?.(token.url);source.set.call(element,token.url);
        }
      }
    }
    return Reflect.apply(target,element,args);
  }});
}
