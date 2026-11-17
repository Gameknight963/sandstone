import {create_crypto_client} from '../../crypto/client.mjs';
import * as rpc from '../../rpc.mjs';
import * as loader from '../loader.mjs';

let client;
export function configure_crypto(available) {
  if (!available || !globalThis.crypto || client) return;
  const command = rpc.create_rpc_wrapper(rpc.host,'crypto');
  client = create_crypto_client((method,args) => command(loader.frame_id,method,args), Array.isArray(available) ? {methods:available} : {});
  Object.defineProperty(globalThis.crypto,'subtle',{get:()=>client.subtle,configurable:true,enumerable:true});
  globalThis.CryptoKey = client.CryptoKey;
  globalThis.SubtleCrypto = client.SubtleCrypto;

  const clone = globalThis.structuredClone;
  globalThis.structuredClone = function structuredClone(value, options) {
    return client.decode(Reflect.apply(clone,globalThis,[client.encode(value),options]));
  };
  const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype,'data');
  const decoded = new WeakMap();
  Object.defineProperty(MessageEvent.prototype,'data',{...data,get() {
    if (!decoded.has(this)) decoded.set(this,client.decode(data.get.call(this)));
    return decoded.get(this);
  }});
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function postMessage(value, transfer) {
    return Reflect.apply(post,this,[client.encode(value),transfer]);
  };
  const globalPost = globalThis.postMessage;
  if (globalPost) globalThis.postMessage = function postMessage(value, ...args) {
    return Reflect.apply(globalPost,this,[client.encode(value),...args]);
  };
}
