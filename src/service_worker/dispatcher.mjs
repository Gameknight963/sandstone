// Each logical event type has a native MessagePort target. Native callback
// cleanup supplies the microtask checkpoint between authored listeners.
export const native_event_target={addEventListener:EventTarget.prototype.addEventListener,removeEventListener:EventTarget.prototype.removeEventListener,dispatchEvent:EventTarget.prototype.dispatchEvent};
export function create_service_worker_dispatcher({events,target=globalThis,nativeTarget=target,started=()=>{},finished=()=>{},types=['install','activate','fetch','message','messageerror']}){
  const add=native_event_target.addEventListener,remove=native_event_target.removeEventListener,dispatch=native_event_target.dispatchEvent;
  const post=MessagePort.prototype.postMessage,start=MessagePort.prototype.start,close=MessagePort.prototype.close;
  const aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get;
  const serviceTypes=new Set(types);
  const PromiseClass=globalThis.Promise,then=PromiseClass.prototype.then,reject=PromiseClass.reject.bind(PromiseClass);
  const channels=new Map(),pending=new Map(),active=new Set();let next=0,closed=false;
  const error=()=>new DOMException('Service worker dispatcher is closed','InvalidStateError');
  function options(value,full=true){
    if(value===null||!['object','function'].includes(typeof value))return {capture:!!value};
    const result={capture:!!value.capture};if(!full)return result;
    result.once=!!value.once;const passive=value.passive;result.passive=passive===undefined?undefined:!!passive;result.signal=value.signal;return result;
  }
  function channel(type){
    if(closed)throw error();if(channels.has(type))return channels.get(type);
    const pair=new MessageChannel(),entry={port1:pair.port1,port2:pair.port2,listeners:new WeakMap(),records:new Set()};channels.set(type,entry);
    add.call(pair.port2,'message',native=>{
      const job=pending.get(native.data);if(!job)return;
      pending.delete(native.data);
      try{
        const result=events.dispatch_event(job.event,()=>{},native,target);
        active.add(job.event);
        started(result,job.event);job.resolve(result);
        Reflect.apply(then,result.lifetime,[()=>{active.delete(job.event);finished(result,job.event);},reason=>{active.delete(job.event);finished(result,job.event,reason);}]);
      }catch(reason){native.stopImmediatePropagation();active.delete(job.event);events.expire(job.event,reason);job.reject(reason);}
    },true);
    start.call(pair.port2);return entry;
  }
  function forget(entry,record){
    record.active=false;entry.records.delete(record);
    if(entry.listeners.get(record.listener)?.get(record.capture)===record)entry.listeners.get(record.listener).delete(record.capture);
    if(record.signal&&record.abort)remove.call(record.signal,'abort',record.abort);
    record.signal=null;record.abort=null;
    remove.call(entry.port2,'message',record.callback,{capture:record.capture});
    remove.call(nativeTarget,record.type,record.callback,{capture:record.capture});
  }
  function addEventListener(type,callback,value){
    type=`${type}`;
    if(!serviceTypes.has(type))return add.call(nativeTarget,type,callback,value);
    const entry=channel(type);
    if(callback===null||!['object','function'].includes(typeof callback))return add.call(entry.port2,'message',callback,value);
    const normalized=options(value),capture=normalized.capture;
    let records=entry.listeners.get(callback);if(!records){records=new Map();entry.listeners.set(callback,records);}
    let record=records.get(capture);
    if(record?.signal&&aborted.call(record.signal)){forget(entry,record);record=null;}
    if(!record){
      record={type,capture,listener:callback,active:false};records.set(capture,record);
      record.callback=function(native){
        if(record.once)forget(entry,record);
        events.listener_options(native,{passive:!!record.passive});
        const event=events.view(native);
        try{
          if(typeof callback==='function')return Reflect.apply(callback,target,[event]);
          return Reflect.apply(callback.handleEvent,callback,[event]);
        }finally{events.listener_options(native,{passive:false});}
      };
    }
    add.call(entry.port2,'message',record.callback,normalized);
    add.call(nativeTarget,type,record.callback,normalized);
    if(!record.active){
      record.once=!!normalized.once;record.passive=!!normalized.passive;record.signal=normalized.signal||null;
      record.active=!record.signal||!aborted.call(record.signal);
      if(record.active){
        entry.records.add(record);
        if(record.signal){const signal=record.signal;record.abort=()=>{if(record.signal===signal)forget(entry,record);};add.call(signal,'abort',record.abort,{once:true});}
      }else record.signal=null;
    }
  }
  function removeEventListener(type,callback,value){
    type=`${type}`;const entry=channels.get(type);
    if(!entry||callback===null||!['object','function'].includes(typeof callback))return remove.call(nativeTarget,type,callback,value);
    const normalized=options(value,false),record=entry.listeners.get(callback)?.get(normalized.capture);
    if(record)forget(entry,record);
  }
  function dispatchEvent(event){return dispatch.call(nativeTarget,events.untrust(event,target));}
  function deliver(event){
    if(closed)return reject(error());
    const type=event.type;if(!serviceTypes.has(type))return reject(new TypeError('Unsupported service worker event type'));
    const entry=channel(type),id=++next;
    return new PromiseClass((resolve,reject)=>{pending.set(id,{event,resolve,reject});try{post.call(entry.port1,id);}catch(reason){pending.delete(id);reject(reason);}});
  }
  function destroy(reason=new DOMException('Service worker was terminated','AbortError')){
    if(closed)return;closed=true;
    for(const job of pending.values())job.reject(reason);pending.clear();
    for(const event of active)events.expire(event,reason);active.clear();
    for(const entry of channels.values()){
      for(const record of entry.records)forget(entry,record);
      close.call(entry.port1);close.call(entry.port2);
    }
    channels.clear();
  }
  return {addEventListener,removeEventListener,dispatchEvent,deliver,destroy};
}
