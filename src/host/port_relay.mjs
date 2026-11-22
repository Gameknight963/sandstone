const transferable_types=['ArrayBuffer','MessagePort','ReadableStream','WritableStream','TransformStream','ImageBitmap','OffscreenCanvas','VideoFrame','AudioData'].map(name=>globalThis[name]).filter(value=>typeof value==='function');
const prototype=Object.getPrototypeOf,plain=Object.prototype;

// Inspect only data already deserialized by a native MessagePort. Forward
// native transferables rather than trying to clone streams or canvases again.
// event.ports also includes transferred ports absent from the message body.
export function message_transfers(value,ports=[]){
  const transfers=new Set(ports),seen=new Set(),pending=[value];
  while(pending.length){
    const item=pending.pop();if(!item||typeof item!=='object'||seen.has(item))continue;seen.add(item);
    if(transferable_types.some(Type=>item instanceof Type)){transfers.add(item);continue;}
    if(ArrayBuffer.isView(item)){if(item.buffer instanceof ArrayBuffer)transfers.add(item.buffer);continue;}
    if(item instanceof Map){for(const [key,value] of item)pending.push(key,value);}
    else if(item instanceof Set){for(const value of item)pending.push(value);}
    else if(item instanceof Error){
      for(const name of ['cause','errors']){const descriptor=Object.getOwnPropertyDescriptor(item,name);if(descriptor&&'value' in descriptor)pending.push(descriptor.value);}
    }else if(Array.isArray(item)||prototype(item)===plain||prototype(item)===null){for(const key of Object.keys(item))pending.push(item[key]);}
  }
  return [...transfers];
}

export class PortRelay{
  constructor(first,second,{onError=()=>{},initial=[[],[]]}={}){
    if(!(first instanceof MessagePort)||!(second instanceof MessagePort)||first===second||typeof onError!=='function'||!Array.isArray(initial)||initial.length!==2||initial.some(events=>!Array.isArray(events)))throw new TypeError('Two distinct native MessagePorts and event queues are required');
    this.ports=[first,second];this.listeners=[];
    for(const [index,source] of this.ports.entries()){
      const destination=this.ports[1-index];
      const failed=error=>{try{onError(error,index);}catch{}};
      const receive=event=>{
        if(this.closed)return;
        if(event.type==='messageerror'){failed(new DOMException('Worker port message could not be deserialized','DataCloneError'));return;}
        try{destination.postMessage(event.data,message_transfers(event.data,event.ports));}
        catch(error){for(const port of event.ports)port.close();failed(error);}
      };
      const error=()=>failed(new DOMException('Worker port message could not be deserialized','DataCloneError'));
      source.addEventListener('message',receive);source.addEventListener('messageerror',error);source.start();
      this.listeners.push({source,receive,error});
    }
    for(const [index,events] of initial.entries())for(const event of events)this.listeners[index].receive(event);
  }
  close(){
    if(this.closed)return;this.closed=true;
    for(const {source,receive,error} of this.listeners){source.removeEventListener('message',receive);source.removeEventListener('messageerror',error);source.close();}
    this.listeners=[];
  }
}
