// Suppress the sandbox's physical link/form activation without presenting that
// internal cancellation to page listeners. Run the virtual default action only
// after dispatch, including when propagation stops before document/window.
import {unwrap_global_target} from './global_functions.mjs';
import {on_shadow_root} from './shadow_roots.mjs';
import {listen_runtime,unlisten_runtime} from './runtime_events.mjs';
import {document_states,unwrap_frame_document} from './document_identity.mjs';
import {event_target,event_callback,native_event_target,event_document,native_element,event_current_target,document_event_alias} from './event_identity.mjs';
import {with_event_scope,mark_authored_event} from '../event_scope.mjs';
let finish_listener=()=>{};
let forget_listeners=()=>{};
let own_gate;
const gates=document_states('link-gates');
export function configure_link_events(){gates.set(globalThis.document,own_gate);}
export function finish_event_listener(event){finish_listener(event);}
export function forget_document_listeners(nodes){forget_listeners(nodes);}
export function install_link_events({enabled,activate,submit}) {
  const records=document_states('link-events'),prepared=new WeakSet(),listeners=document_states('link-listeners');
  const active_entries=document_states('link-entries');
  const untrack=(target,entry)=>active_entries.get(target)?.delete(entry);
  forget_listeners=nodes=>{for(const node of nodes){for(const entry of active_entries.get(node)||[]){entry.active=false;entry.cleanup?.();}active_entries.delete(node);listeners.delete(node);}};
  const pending=new Set(),submitter=globalThis.SubmitEvent&&Object.getOwnPropertyDescriptor(SubmitEvent.prototype,'submitter').get;
  const eventProto=Event.prototype,targetProto=EventTarget.prototype;
  const prevented=Object.getOwnPropertyDescriptor(eventProto,'defaultPrevented');
  const returnValue=Object.getOwnPropertyDescriptor(eventProto,'returnValue');
  const prevent=eventProto.preventDefault,add=targetProto.addEventListener,remove=targetProto.removeEventListener;
  const form_method=Object.getOwnPropertyDescriptor(HTMLFormElement.prototype,'method').get;
  const isForm=node=>{try{form_method.call(node);return true;}catch{return false;}};
  function listener_options(options,full=true){
    if(options==null||!['object','function'].includes(typeof options))return {capture:!!options};
    const capture=!!options.capture;
    if(!full)return {capture};
    const once=!!options.once,passive=options.passive,signal=options.signal;
    return {capture,once,passive:passive===undefined?undefined:!!passive,signal};
  }
  const isLink=node=>native_element(node)&&Element.prototype.matches.call(node,'a[href], area[href]');
  const tracked=type=>type==='click'||type==='submit';
  function complete(record){
    if(record.complete&&record.complete!==complete)return record.complete(record);
    if(!record.queued)return;
    record.queued=false;pending.delete(record);clearTimeout(record.timer);
    if(!record.duringCancelled)record.action();
  }
  function flush(){for(const record of [...pending])if(record.event.eventPhase===Event.NONE)complete(record);}
  function schedule(record){if(record?.queued)record.schedule();}
  finish_listener=event=>{const record=records.get(event);if(event?.type==='submit'&&record?.immediate)schedule(record);};
  // Trusted user input has no script-level dispatch wrapper to flush it.
  // Finish after the last listener on its path, before author timers can
  // change the fields. Immediate stops finish through the listener wrapper.
  const tails=new WeakMap();
  function tail(event){
    if(event.type==='submit'&&(event.cancelBubble||event.currentTarget===event.composedPath().at(-1)&&event.eventPhase===Event.BUBBLING_PHASE))schedule(records.get(event));
  }
  function prepare_tail(node,capture){
    node=unwrap_frame_document(node);
    if(!(node instanceof EventTarget))return;
    let state=tails.get(node);if(!state){state=new Set();tails.set(node,state);}
    // Listeners added while this phase is running are excluded from its native
    // snapshot. Keep its existing tail in that snapshot, too.
    if(state.has(capture)&&[...pending].some(record=>event_current_target(record.event)===node))return;
    if(state.has(capture))unlisten_runtime(node,'submit',tail,capture);
    listen_runtime(node,'submit',tail,capture);state.add(capture);
  }
  function gate(event){
    const owner=gates.get(event_document(event.target));
    if(owner&&owner!==gate)return owner(event);
    if(!enabled())return;
    let element,action;
    if(event.type==='submit'){
      if(!submit||!event.isTrusted||!isForm(event.target))return;
      element=event.target;
      const button=submitter?submitter.call(event):event.submitter;
      action=()=>submit(element,button).catch(console.error);
    }else{
      element=event.composedPath().find(isLink);if(!element)return;
      action=()=>activate(element);
    }
    let record=records.get(event);
    if(record?.queued)return;
    const cancelled=record?record.cancelled:prevented.get.call(event),activated=!!record?.activated;
    record={cancelled,duringCancelled:cancelled,queued:true,passive:false,activated:true,event,action,complete,schedule:()=>queueMicrotask(()=>complete(record))};records.set(event,record);
    prevent.call(event);
    // A native MouseEvent's activation is handled once even if dispatched again.
    if(!activated){
      if(event.type==='submit'){
        pending.add(record);
        for(const node of event.composedPath()){prepare_tail(node,true);prepare_tail(node,false);}
      }
      record.timer=setTimeout(()=>complete(record),0);
    }
  }
  function prepare(node){
    // Detached FileSaver anchors and closed shadow roots do not reach the
    // window capture listener. Install before their author listeners.
    while(native_element(node)){
      if(Element.prototype.matches.call(node,'a, area, form')){
        if(!prepared.has(node)){prepared.add(node);listen_runtime(node,isForm(node)?'submit':'click',gate,true);}
        return;
      }
      node=node.parentElement||node.getRootNode()?.host;
    }
  }
  own_gate=gate;
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
  const stopImmediate=eventProto.stopImmediatePropagation;
  eventProto.stopImmediatePropagation=new Proxy(stopImmediate,{apply(target,receiver,args){
    const result=Reflect.apply(target,receiver,args),record=records.get(receiver);
    if(record)record.immediate=true;
    return result;
  }});
  if(returnValue)Object.defineProperty(eventProto,'returnValue',{...returnValue,
    get(){return records.has(this)?!records.get(this).cancelled:returnValue.get.call(this);},
    set(value){if(!value)cancel(this);else returnValue.set.call(this,value);}
  });
  targetProto.addEventListener=new Proxy(add,{apply(target,receiver,args){
    const alias=receiver??globalThis;
    receiver=unwrap_frame_document(unwrap_global_target(receiver??globalThis));
    if(!native_event_target(receiver))return Reflect.apply(target,receiver,args);
    if(args.length<2)return Reflect.apply(target,receiver,args);
    const type=`${args[0]}`,[,authored,options]=args,listener=event_callback(receiver,authored,true,alias);
    if(!tracked(type)||!listener||!['function','object'].includes(typeof listener))return Reflect.apply(target,receiver,[type,listener,...args.slice(2)]);
    prepare(receiver);
    const normalized=listener_options(options),capture=normalized.capture;
    let callbacks=listeners.get(receiver);if(!callbacks){callbacks=new WeakMap();listeners.set(receiver,callbacks);}
    let captures=callbacks.get(listener);if(!captures){captures=new Map();callbacks.set(listener,captures);}
    const key=type+':'+capture;
    let entry=captures.get(key);
    if(!entry?.active){
      entry={active:false,passive:!!normalized.passive,once:!!normalized.once};
      entry.callback=function(event){
        if(entry.once){entry.active=false;entry.cleanup?.();untrack(receiver,entry);}
        const record=records.get(event),previous=record?.passive;
        if(record)record.passive=entry.passive;
        try{return typeof listener==='function'?listener.call(this,event):listener.handleEvent(event);}
        finally{if(record)record.passive=previous;finish_event_listener(event);}
      };
      captures.set(key,entry);
    }
    const active=entry.active,result=Reflect.apply(target,receiver,[type,entry.callback,normalized]);
    if(!active){
      entry.active=!normalized.signal?.aborted;
      if(entry.active){let entries=active_entries.get(receiver);if(!entries){entries=new Set();active_entries.set(receiver,entries);}entries.add(entry);}
      if(entry.active&&normalized.signal){
        const aborted=()=>{entry.active=false;untrack(receiver,entry);};
        add.call(normalized.signal,'abort',aborted,{once:true});
        entry.cleanup=()=>remove.call(normalized.signal,'abort',aborted);
      }
    }
    if(type==='submit'){prepare_tail(receiver,true);prepare_tail(receiver,false);}
    return result;
  }});
  targetProto.removeEventListener=new Proxy(remove,{apply(target,receiver,args){
    receiver=unwrap_frame_document(unwrap_global_target(receiver??globalThis));
    if(!native_event_target(receiver))return Reflect.apply(target,receiver,args);
    if(args.length<2)return Reflect.apply(target,receiver,args);
    const type=`${args[0]}`,[,authored,options]=args,listener=event_callback(receiver,authored,false);
    if(!tracked(type)||!listener||!['function','object'].includes(typeof listener))return Reflect.apply(target,receiver,[type,listener,...args.slice(2)]);
    const normalized=listener_options(options,false),capture=normalized.capture;
    const entry=listeners.get(receiver)?.get(listener)?.get(type+':'+capture);
    if(entry){entry.active=false;entry.cleanup?.();untrack(receiver,entry);return Reflect.apply(target,receiver,[type,entry.callback,normalized]);}
    return Reflect.apply(target,receiver,[type,listener,normalized]);
  }});
  const dispatch=targetProto.dispatchEvent;
  targetProto.dispatchEvent=new Proxy(dispatch,{apply(target,receiver,args){
    const alias=receiver??globalThis;
    receiver=unwrap_frame_document(unwrap_global_target(receiver??globalThis));
    const event=args[0];prepare(receiver);
    if(tracked(event?.type)&&event.eventPhase===Event.NONE&&records.has(event)){
      const {cancelled,activated}=records.get(event);records.set(event,{cancelled,duringCancelled:cancelled,queued:false,activated});
    }
    const result=Reflect.apply(target,receiver,args),record=records.get(event);mark_authored_event(event,document_event_alias(receiver,alias));flush();
    return record?!record.cancelled:result;
  }});
  // Native property handlers cancel internally when returning false. Mirror
  // that cancellation through the tracked method while preserving identity.
  const handlers=document_states('link-properties');
  for(const name of ['onclick','onsubmit']){
    const owners=new Set();
    for(const start of [HTMLElement.prototype,globalThis.SVGElement?.prototype,Document.prototype,globalThis]){
      let owner=start;while(owner&&!Object.hasOwn(owner,name))owner=Object.getPrototypeOf(owner);
      if(!owner||owners.has(owner))continue;owners.add(owner);
      const property=Object.getOwnPropertyDescriptor(owner,name);
      if(!property?.set)continue;
      Object.defineProperty(owner,name,{...property,
        get(){const handler=property.get.call(this);return handlers.get(handler)||handler;},
        set(handler){
          prepare(this);
          if(typeof handler!=='function')return property.set.call(this,handler);
          const wrapper=function(...args){return with_event_scope(args[0],true,()=>{try{const result=handler.apply(event_target(this,args[0]),args);if(result===false)args[0]?.preventDefault();return result;}finally{finish_event_listener(args[0]);}});};
          handlers.set(wrapper,handler);const result=property.set.call(this,wrapper);
          if(name==='onsubmit'){prepare_tail(this,true);prepare_tail(this,false);}
          return result;
        }
      });
    }
  }
  const click=HTMLElement.prototype.click;
  HTMLElement.prototype.click=new Proxy(click,{apply(target,receiver,args){prepare(receiver);const result=Reflect.apply(target,receiver,args);flush();return result;}});
  const requestSubmit=HTMLFormElement.prototype.requestSubmit;
  if(requestSubmit)HTMLFormElement.prototype.requestSubmit=new Proxy(requestSubmit,{apply(target,receiver,args){prepare(receiver);const result=Reflect.apply(target,receiver,args);flush();return result;}});
  // Declarative parsing and native cloning create roots without attachShadow.
  // Observe every discovered root before authored handlers can stop its events.
  const shadow_events=new WeakSet();
  on_shadow_root(root=>{
    if(shadow_events.has(root))return;
    shadow_events.add(root);listen_runtime(root,'click',gate,true);listen_runtime(root,'submit',gate,true);prepare_tail(root,true);prepare_tail(root,false);
  });
  listen_runtime(globalThis,'click',gate,true);
  listen_runtime(globalThis,'submit',gate,true);
  prepare_tail(globalThis,true);prepare_tail(globalThis,false);
}
