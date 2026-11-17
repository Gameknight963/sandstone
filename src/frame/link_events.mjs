// Suppress the sandbox's physical link activation without presenting that
// internal cancellation to page listeners. Run the virtual default action only
// after dispatch, including when propagation stops before document/window.
import {unwrap_global_target} from './global_functions.mjs';
export function install_link_events({enabled,activate}) {
  const records=new WeakMap(),prepared=new WeakSet(),listeners=new WeakMap();
  const eventProto=Event.prototype,targetProto=EventTarget.prototype;
  const prevented=Object.getOwnPropertyDescriptor(eventProto,'defaultPrevented');
  const returnValue=Object.getOwnPropertyDescriptor(eventProto,'returnValue');
  const prevent=eventProto.preventDefault,add=targetProto.addEventListener,remove=targetProto.removeEventListener;
  function listener_options(options,full=true){
    if(options==null||!['object','function'].includes(typeof options))return {capture:!!options};
    const capture=!!options.capture;
    if(!full)return {capture};
    const once=!!options.once,passive=options.passive,signal=options.signal;
    return {capture,once,passive:passive===undefined?undefined:!!passive,signal};
  }
  const isLink=node=>node instanceof Element&&Element.prototype.matches.call(node,'a[href], area[href]');
  function gate(event){
    if(!enabled())return;
    const element=event.composedPath().find(isLink);if(!element)return;
    let record=records.get(event);
    if(record?.queued)return;
    const cancelled=record?record.cancelled:prevented.get.call(event),activated=!!record?.activated;
    record={cancelled,duringCancelled:cancelled,queued:true,passive:false,activated:true};records.set(event,record);
    prevent.call(event);
    // A native MouseEvent's activation is handled once even if dispatched again.
    if(!activated)setTimeout(()=>{if(!record.duringCancelled)activate(element);},0);
  }
  function prepare(node){
    // Detached FileSaver anchors and closed shadow roots do not reach the
    // window capture listener. Install before their author click listeners.
    while(node instanceof Element){
      if(Element.prototype.matches.call(node,'a, area')){
        if(!prepared.has(node)){prepared.add(node);add.call(node,'click',gate,true);}
        return;
      }
      node=node.parentElement||node.getRootNode()?.host;
    }
  }
  Object.defineProperty(eventProto,'defaultPrevented',{...prevented,get(){return records.get(this)?.cancelled??prevented.get.call(this);}});
  function cancel(event){
    const record=records.get(event);
    if(record){
      if(record.passive)return;
      if(event.cancelable){record.cancelled=true;if(event.eventPhase!==Event.NONE)record.duringCancelled=true;}
    }
    return prevent.call(event);
  }
  eventProto.preventDefault=new Proxy(prevent,{apply(target,receiver){return cancel(receiver);}});
  if(returnValue)Object.defineProperty(eventProto,'returnValue',{...returnValue,
    get(){return records.has(this)?!records.get(this).cancelled:returnValue.get.call(this);},
    set(value){if(!value)cancel(this);else returnValue.set.call(this,value);}
  });
  targetProto.addEventListener=new Proxy(add,{apply(target,receiver,args){
    receiver=unwrap_global_target(receiver??globalThis);
    if(!(receiver instanceof EventTarget))return Reflect.apply(target,receiver,args);
    const [type,listener,options]=args;
    if(type!=='click'||!listener||!['function','object'].includes(typeof listener))return Reflect.apply(target,receiver,args);
    prepare(receiver);
    const normalized=listener_options(options),capture=normalized.capture;
    let callbacks=listeners.get(receiver);if(!callbacks){callbacks=new WeakMap();listeners.set(receiver,callbacks);}
    let captures=callbacks.get(listener);if(!captures){captures=new Map();callbacks.set(listener,captures);}
    let entry=captures.get(capture);
    if(!entry?.active){
      entry={active:false,passive:!!normalized.passive,once:!!normalized.once};
      entry.callback=function(event){
        if(entry.once){entry.active=false;entry.cleanup?.();}
        const record=records.get(event),previous=record?.passive;
        if(record)record.passive=entry.passive;
        try{return typeof listener==='function'?listener.call(this,event):listener.handleEvent(event);}
        finally{if(record)record.passive=previous;}
      };
      captures.set(capture,entry);
    }
    const active=entry.active,result=Reflect.apply(target,receiver,[type,entry.callback,normalized]);
    if(!active){
      entry.active=!normalized.signal?.aborted;
      if(entry.active&&normalized.signal){
        const aborted=()=>{entry.active=false;};
        add.call(normalized.signal,'abort',aborted,{once:true});
        entry.cleanup=()=>remove.call(normalized.signal,'abort',aborted);
      }
    }
    return result;
  }});
  targetProto.removeEventListener=new Proxy(remove,{apply(target,receiver,args){
    receiver=unwrap_global_target(receiver??globalThis);
    if(!(receiver instanceof EventTarget))return Reflect.apply(target,receiver,args);
    const [type,listener,options]=args;
    if(type!=='click')return Reflect.apply(target,receiver,args);
    const normalized=listener_options(options,false),capture=normalized.capture;
    const entry=type==='click'&&listener&&listeners.get(receiver)?.get(listener)?.get(capture);
    if(entry){entry.active=false;entry.cleanup?.();return Reflect.apply(target,receiver,[type,entry.callback,normalized]);}
    return Reflect.apply(target,receiver,[type,listener,normalized]);
  }});
  const dispatch=targetProto.dispatchEvent;
  targetProto.dispatchEvent=new Proxy(dispatch,{apply(target,receiver,args){
    receiver=unwrap_global_target(receiver??globalThis);
    const event=args[0];prepare(receiver);
    if(event?.type==='click'&&event.eventPhase===Event.NONE&&records.has(event)){
      const {cancelled,activated}=records.get(event);records.set(event,{cancelled,duringCancelled:cancelled,queued:false,activated});
    }
    const result=Reflect.apply(target,receiver,args),record=records.get(event);
    return record?!record.cancelled:result;
  }});
  // Native property handlers cancel internally when returning false. Mirror
  // that cancellation through the tracked method while preserving identity.
  const handlers=new WeakMap(),owners=new Set();
  for(const start of [HTMLElement.prototype,globalThis.SVGElement?.prototype,Document.prototype,globalThis]){
    let owner=start;while(owner&&!Object.hasOwn(owner,'onclick'))owner=Object.getPrototypeOf(owner);
    if(!owner||owners.has(owner))continue;owners.add(owner);
    const property=Object.getOwnPropertyDescriptor(owner,'onclick');
    if(!property?.set)continue;
    Object.defineProperty(owner,'onclick',{...property,
      get(){const handler=property.get.call(this);return handlers.get(handler)||handler;},
      set(handler){
        prepare(this);
        if(typeof handler!=='function')return property.set.call(this,handler);
        const wrapper=function(...args){const result=handler.apply(this,args);if(result===false)args[0]?.preventDefault();return result;};
        handlers.set(wrapper,handler);return property.set.call(this,wrapper);
      }
    });
  }
  const click=HTMLElement.prototype.click;
  HTMLElement.prototype.click=new Proxy(click,{apply(target,receiver,args){prepare(receiver);return Reflect.apply(target,receiver,args);}});
  const attachShadow=Element.prototype.attachShadow;
  if(attachShadow)Element.prototype.attachShadow=new Proxy(attachShadow,{apply(target,receiver,args){
    const root=Reflect.apply(target,receiver,args);add.call(root,'click',gate,true);return root;
  }});
  add.call(globalThis,'click',gate,true);
}
