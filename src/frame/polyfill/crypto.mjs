import {create_crypto_client} from '../../crypto/client.mjs';
import * as rpc from '../../rpc.mjs';
import * as loader from '../loader.mjs';
import {configure_clone} from '../clone.mjs';

let client;
export function encode_message(value){return client?client.encode(value):value;}
export function configure_crypto(available) {
  if (!available || !globalThis.crypto || client) return;
  const command = rpc.create_rpc_wrapper(rpc.host,'crypto');
  client = create_crypto_client((method,args) => command(loader.frame_id,method,args), Array.isArray(available) ? {methods:available} : {});
  Object.defineProperty(globalThis.crypto,'subtle',{get:()=>client.subtle,configurable:true,enumerable:true});
  globalThis.CryptoKey = client.CryptoKey;
  globalThis.SubtleCrypto = client.SubtleCrypto;

  const clone = globalThis.structuredClone;
  globalThis.structuredClone = new Proxy(clone,{apply(target,receiver,args){return client.decode(Reflect.apply(target,receiver,args));}});
  configure_clone(globalThis.structuredClone);
  const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype,'data');
  const decoded = new WeakMap();
  Object.defineProperty(MessageEvent.prototype,'data',{...data,get() {
    const value=data.get.call(this),previous=decoded.get(this);
    // A window-message capture listener can replace a transport envelope with
    // its payload after an earlier internal listener inspected the same event.
    if(!previous||previous.source!==value)decoded.set(this,{source:value,value:client.decode(value)});
    return decoded.get(this).value;
  }});
}
