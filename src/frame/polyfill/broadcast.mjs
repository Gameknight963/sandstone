import * as loader from '../loader.mjs';
import * as rpc from '../../rpc.mjs';
import {encode_message} from './crypto.mjs';

const states=new WeakMap(),Port=globalThis.MessagePort;
const close=Port.prototype.close,start=Port.prototype.start,clone=globalThis.structuredClone;
const command=(info,type,value)=>rpc.call_procedure(rpc.host,'broadcast_command',[info.context,info.id,type,value]);
const add=EventTarget.prototype.addEventListener;
const state=channel=>{const value=states.get(channel);if(!value)throw new TypeError('Invalid BroadcastChannel receiver');return value;};

export class BroadcastChannel extends EventTarget {
  constructor(name){
    super();
    if(!arguments.length)throw new TypeError('BroadcastChannel requires a name');
    name=`${name}`;
    const channel=new MessageChannel(),port=channel.port1;
    // Keep the native port as the EventTarget so delivery retains native trust,
    // listener ordering, target/currentTarget identity and cancellation.
    Object.setPrototypeOf(port,new.target.prototype);
    const id=Array.from(crypto.getRandomValues(new Uint32Array(4))).join(':');
    states.set(port,{name,id,context:loader.beacon_context,closed:false});
    add.call(port,'message',event=>{
      if(!event.isTrusted)return;
      const value=event.data;
      if(value.type==='messageerror'){
        event.stopImmediatePropagation();
        port.dispatchEvent(new MessageEvent('messageerror',{origin:value.origin}));return;
      }
      Object.defineProperties(event,{data:{value:value.data},origin:{value:value.origin}});
    },true);
    start.call(port);
    rpc.call_procedure(rpc.host,'broadcast_open',[loader.beacon_context,id,name,channel.port2],{transfer:[channel.port2]}).catch(()=>{
      if(!state(port).closed)port.dispatchEvent(new MessageEvent('messageerror'));
    });
    return port;
  }
  get name(){return state(this).name;}
  postMessage(value){
    const info=state(this);
    if(!arguments.length)throw new TypeError('postMessage requires a message');
    if(info.closed)throw new DOMException('BroadcastChannel is closed','InvalidStateError');
    // Use the same ordered RPC port for open/post/close. A separate command
    // port could deliver a post before the next local channel was registered.
    const snapshot=clone(encode_message(value));
    command(info,'post',snapshot).catch(()=>{if(!info.closed)this.dispatchEvent(new MessageEvent('messageerror'));});
  }
  close(){
    const info=state(this);if(info.closed)return;
    info.closed=true;command(info,'close').catch(()=>{});close.call(this);
  }
  get [Symbol.toStringTag](){return 'BroadcastChannel';}
}
for(const name of ['onmessage','onmessageerror'])Object.defineProperty(BroadcastChannel.prototype,name,Object.getOwnPropertyDescriptor(Port.prototype,name));
