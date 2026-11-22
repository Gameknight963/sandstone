import {PortRelay,message_transfers} from '../host/port_relay.mjs';

const disposers=[['MessagePort','close'],['ReadableStream','cancel'],['WritableStream','abort'],['ImageBitmap','close'],['VideoFrame','close'],['AudioData','close']]
  .map(([name,method])=>[globalThis[name],method,globalThis[name]?.prototype[method]]).filter(([Type,,method])=>Type&&typeof method==='function');
function discard(event,reason){
  for(const value of message_transfers(event.data,event.ports)){
    if(globalThis.TransformStream&&value instanceof TransformStream){try{value.readable.cancel(reason).catch(()=>{});value.writable.abort(reason).catch(()=>{});}catch{}continue;}
    for(const [Type,name,method] of disposers)if(value instanceof Type){try{Reflect.apply(method,value,name==='close'?[]:[reason])?.catch?.(()=>{});}catch{}break;}
  }
}

// Start a native actor port only in its retained backend. Reading the private
// greeting must not discard authored packets posted immediately after it.
export class ActorInbox{
  constructor(port,nonce,{signal}={}){
    if(!(port instanceof MessagePort)||typeof nonce!=='string'||!nonce)throw new TypeError('A native actor port and nonce are required');
    if(signal!=null&&(typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'))throw new TypeError('An actor lifetime signal is required');
    this.port=port;this.queue=[];this.signal=signal;
    this.ready=new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject;});this.ready.catch(()=>{});
    this.receive=event=>{
      if(this.closed)return;
      if(!this.hello){
        const value=event.data;
        if(event.type!=='message'||value?.sandstone_actor!==nonce||value.type!=='hello'||!['bootstrap','initializing','ready'].includes(value.phase)||typeof value.instance!=='string'||!/^[a-f0-9]{32}$/.test(value.instance)){
          const reason=new DOMException('Invalid native actor greeting','SecurityError');discard(event,reason);this.close(reason);return;
        }
        if(event.ports.length){const reason=new DOMException('An actor greeting cannot transfer ports','DataCloneError');discard(event,reason);this.close(reason);return;}
        this.hello=Object.freeze({instance:value.instance,phase:value.phase});this.resolve(this.hello);return;
      }
      this.queue.push({type:event.type,data:event.data,ports:[...event.ports]});
    };
    this.abort=()=>this.close(signal.reason);
    port.addEventListener('message',this.receive);port.addEventListener('messageerror',this.receive);port.start();
    signal?.addEventListener('abort',this.abort,{once:true});if(signal?.aborted)this.abort();
  }
  detach(){
    this.port.removeEventListener('message',this.receive);this.port.removeEventListener('messageerror',this.receive);this.signal?.removeEventListener('abort',this.abort);
  }
  bridge(peer,options={}){
    if(this.closed||this.handed||!this.hello)throw new DOMException('Actor port is not available for handoff','InvalidStateError');
    this.detach();
    try{
      const relay=new PortRelay(this.port,peer,{...options,initial:[this.queue,[]]});this.queue=[];this.handed=true;return relay;
    }catch(error){this.close(error);throw error;}
  }
  close(reason=new DOMException('Actor port is closed','AbortError')){
    if(this.closed||this.handed)return;this.closed=true;this.detach();this.port.close();
    for(const event of this.queue)discard(event,reason);this.queue=[];this.reject(reason);
  }
}
