import {consume_filtered_response} from '../response_metadata.mjs';
// This runtime is private until a service-worker host supplies trusted events.
// Ordinary constructors and authored dispatches cannot grant lifetime rights.
export function create_service_worker_events({Event:NativeEvent=globalThis.Event,Request:NativeRequest=globalThis.Request,Response:NativeResponse=globalThis.Response,requestMetadata,responseMetadata,sourceValid}={}){
  const states=new WeakMap(),listeners=new WeakMap();
  const PromiseClass=globalThis.Promise,microtask=globalThis.queueMicrotask.bind(globalThis);
  const resolve=PromiseClass.resolve.bind(PromiseClass),then=PromiseClass.prototype.then;
  const upon=(promise,yes,no)=>Reflect.apply(then,promise,[yes,no]);
  const HeaderClass=globalThis.Headers,StreamClass=globalThis.ReadableStream;
  const blobStream=Blob.prototype.stream;
  // Standalone event realms have no relayed responses or private snapshots.
  const consumeFiltered=typeof consume_filtered_response==='function'?consume_filtered_response:undefined;
  const wellFormed=String.prototype.toWellFormed;
  const timeout=globalThis.setTimeout.bind(globalThis),clear_timeout=globalThis.clearTimeout.bind(globalThis);
  const eventStop=NativeEvent.prototype.stopImmediatePropagation;
  const eventPhase=Object.getOwnPropertyDescriptor(NativeEvent.prototype,'eventPhase').get;
  const requestFields=Object.fromEntries(['url','mode','redirect'].map(key=>[key,Object.getOwnPropertyDescriptor(NativeRequest.prototype,key).get]));
  const responseFields=Object.fromEntries(['body','bodyUsed','status','statusText','headers','url','type','redirected'].map(key=>[key,Object.getOwnPropertyDescriptor(NativeResponse.prototype,key).get]));
  const streamReader=ReadableStream.prototype.getReader,streamLocked=Object.getOwnPropertyDescriptor(ReadableStream.prototype,'locked').get;
  const typedArray=Object.getPrototypeOf(Uint8Array.prototype),typedTag=Object.getOwnPropertyDescriptor(typedArray,Symbol.toStringTag).get;
  const typedFields=Object.fromEntries(['buffer','byteOffset','byteLength'].map(key=>[key,Object.getOwnPropertyDescriptor(typedArray,key).get]));
  const portGetter=Object.getOwnPropertyDescriptor(globalThis.MessagePort?.prototype||{},'onmessage')?.get;
  const sourceGetters=[[globalThis.Client,'id'],[globalThis.ServiceWorker,'scriptURL']].map(([constructor,key])=>constructor&&Object.getOwnPropertyDescriptor(constructor.prototype,key)?.get).filter(Boolean);
  const invalid=()=>new DOMException('The service worker event is not active','InvalidStateError');
  const state=event=>{const value=states.get(event);if(!value||value.generic)throw new TypeError('Illegal service worker event receiver');return value;};
  const fetch_state=event=>{const value=state(event);if(!value.fetch)throw new TypeError('Illegal FetchEvent receiver');return value;};
  const deferred=()=>{let resolve,reject;const promise=new PromiseClass((yes,no)=>{resolve=yes;reject=no;});upon(promise,undefined,()=>{});return {promise,resolve,reject};};
  const dispatching=data=>data.dispatching||!!data.parent&&eventPhase.call(data.parent)!==0;
  function complete(data){
    if(data.finished||dispatching(data)||data.pending)return;
    data.finished=true;if(data.errors.length)data.lifetime.reject(data.errors[0]);else data.lifetime.resolve();
  }
  function extend(data,promise){
    if(!data.trusted||data.expired||!dispatching(data)&&!data.pending)throw invalid();
    data.pending++;
    const settled=(failed,error)=>microtask(()=>{if(failed)data.errors.push(error);data.pending--;complete(data);});
    upon(promise,()=>settled(false),error=>settled(true,error));
  }
  class ExtendableEvent extends NativeEvent{
    constructor(type,init={}){
      if(!arguments.length)throw new TypeError('An event type is required');
      super(type,init);
      states.set(this,{raw:this,trusted:false,dispatching:false,delivered:false,expired:false,finished:false,pending:0,errors:[],lifetime:deferred(),dispatched:deferred(),methods:new Map()});
    }
    waitUntil(promise){
      const data=state(this);if(!arguments.length)throw new TypeError('A lifetime promise is required');
      extend(data,resolve(promise));
    }
  }
  function adopt(event){
    eventPhase.call(event);
    if(!states.has(event))states.set(event,{raw:event,trusted:false,dispatching:false,delivered:false,expired:false,finished:false,pending:0,errors:[],lifetime:deferred(),dispatched:deferred(),methods:new Map()});
    return event;
  }
  function response_handle(data,response){
    const body=responseFields.body.call(response),native=Object.fromEntries(['status','statusText','headers','url','type','redirected'].map(key=>[key,responseFields[key].call(response)]));
    const sourceMetadata=responseMetadata?.(response)||native,metadata={...sourceMetadata,headers:new HeaderClass(sourceMetadata.headers)},policy=requestMetadata?.(data.request)||{mode:requestFields.mode.call(data.request),redirect:requestFields.redirect.call(data.request)};
    // Script-created responses cannot set browser cookies. Real network
    // response cookies have already been processed by the relay's transport.
    metadata.headers.delete('set-cookie');metadata.headers.delete('set-cookie2');
    if(data.expired)throw invalid();
    if(metadata.type==='error'||metadata.type==='opaque'&&policy.mode!=='no-cors'||metadata.type==='opaqueredirect'&&policy.redirect!=='manual'||metadata.type==='cors'&&policy.mode==='same-origin')throw new TypeError('Service worker response type does not match the request');
    if(responseFields.bodyUsed.call(response)||body&&streamLocked.call(body))throw new TypeError('Service worker response body is used or locked');
    const hidden=consumeFiltered?.(response);
    if(hidden)return upon(hidden,blob=>{if(data.expired)throw invalid();return response_reader(data,response,metadata,blob===null?null:Reflect.apply(blobStream,blob,[]));});
    return response_reader(data,response,metadata,body);
  }
  function response_reader(data,response,metadata,body){
    let reader=null;
    if(body){
      const original=streamReader.call(body);
      const stream=new StreamClass({
        async pull(controller){
          try{
            const result=await original.read();
            if(result.done){controller.close();return;}
            if(typedTag.call(result.value)!=='Uint8Array')throw new TypeError('Service worker response chunks must be Uint8Array');
            const buffer=typedFields.buffer.call(result.value),offset=typedFields.byteOffset.call(result.value),length=typedFields.byteLength.call(result.value);
            const bytes=new Uint8Array(buffer,offset,length).slice();
            controller.enqueue(bytes);
          }catch(error){controller.error(new TypeError('Service worker response stream failed'));try{await original.cancel(error);}catch{}}
        },
        cancel:reason=>original.cancel(reason)
      });
      reader=streamReader.call(stream);
    }
    return data.handle={response,metadata,reader};
  }
  class FetchEvent extends ExtendableEvent{
    constructor(type,init){
      if(arguments.length<2)throw new TypeError('A fetch event type and request dictionary are required');
      super(type,init);
      const dictionary=init??{},data=state(this);
      data.fetch=true;
      // Derived dictionary members follow EventInit's native conversion.
      const client=dictionary.clientId;data.clientId=client===undefined?'':`${client}`;
      const handled=dictionary.handled;data.handledOwner=handled===undefined?deferred():null;data.handled=handled===undefined?data.handledOwner.promise:resolve(handled);
      const preload=dictionary.preloadResponse;data.preloadResponse=resolve(preload);
      const replaces=dictionary.replacesClientId;data.replacesClientId=replaces===undefined?'':`${replaces}`;
      const request=dictionary.request;requestFields.url.call(request);data.request=request;
      const resulting=dictionary.resultingClientId;data.resultingClientId=resulting===undefined?'':`${resulting}`;
      data.responded=false;data.response=null;
    }
    get request(){return fetch_state(this).request;}
    get preloadResponse(){return fetch_state(this).preloadResponse;}
    get clientId(){return fetch_state(this).clientId;}
    get resultingClientId(){return fetch_state(this).resultingClientId;}
    get replacesClientId(){return fetch_state(this).replacesClientId;}
    get handled(){return fetch_state(this).handled;}
    respondWith(response){
      const data=fetch_state(this);if(!arguments.length)throw new TypeError('A response promise is required');
      const promise=resolve(response);
      if(!dispatching(data)||data.responded)throw invalid();
      extend(data,promise);eventStop.call(data.raw);if(data.parent)eventStop.call(data.parent);data.responded=true;data.response=deferred();
      upon(promise,value=>{
        try{upon(resolve(response_handle(data,value)),handle=>data.response.resolve(handle),error=>data.response.reject(error));}catch(error){data.response.reject(error);}
      },error=>data.response.reject(error));
    }
  }
  function port(value){
    if(portGetter){try{portGetter.call(value);return value;}catch{}}
    else if(globalThis.MessagePort&&value instanceof MessagePort)return value;
    throw new TypeError('Message event ports must be MessagePort objects');
  }
  const message_state=event=>{const data=state(event);if(!data.message)throw new TypeError('Illegal ExtendableMessageEvent receiver');return data;};
  class ExtendableMessageEvent extends ExtendableEvent{
    constructor(type,init={}){
      if(!arguments.length)throw new TypeError('An event type is required');super(type,init);
      const dictionary=init??{},data=state(this);data.message=true;
      const value=dictionary.data;data.messageData=value===undefined?null:value;
      const id=dictionary.lastEventId;data.lastEventId=id===undefined?'':`${id}`;
      const origin=dictionary.origin,text=origin===undefined?'':`${origin}`;
      data.origin=wellFormed?wellFormed.call(text):text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g,part=>part.length===2?part:'\uFFFD');
      const ports=dictionary.ports;
      if(ports===undefined)data.ports=Object.freeze([]);
      else{
        if(ports===null||!['object','function'].includes(typeof ports))throw new TypeError('Message event ports must be a sequence');
        const iterator=ports[Symbol.iterator];if(typeof iterator!=='function')throw new TypeError('Message event ports must be iterable');
        data.ports=Object.freeze(Array.from({[Symbol.iterator]:()=>Reflect.apply(iterator,ports,[])},port));
      }
      const source=dictionary.source;data.source=source??null;
      if(data.source!==null){
        if(!['object','function'].includes(typeof data.source))throw new TypeError('Invalid message event source');
        let valid=false;try{port(data.source);valid=true;}catch{}
        for(const getter of sourceGetters)try{getter.call(data.source);valid=true;break;}catch{}
        if(!valid&&!sourceValid?.(data.source))throw new TypeError('Invalid message event source');
      }
    }
    get data(){return message_state(this).messageData;}
    get origin(){return message_state(this).origin;}
    get lastEventId(){return message_state(this).lastEventId;}
    get source(){return message_state(this).source;}
    get ports(){return message_state(this).ports;}
  }
  for(const [name,constructor] of [['ExtendableEvent',ExtendableEvent],['FetchEvent',FetchEvent],['ExtendableMessageEvent',ExtendableMessageEvent]]){
    for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(constructor.prototype)))if(key!=='constructor')Object.defineProperty(constructor.prototype,key,{...descriptor,enumerable:true});
    Object.defineProperty(constructor.prototype,Symbol.toStringTag,{value:name,configurable:true});
  }
  const methods=new Map();
  for(const prototype of [NativeEvent.prototype,ExtendableEvent.prototype,FetchEvent.prototype,ExtendableMessageEvent.prototype])for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(prototype)))if(key!=='constructor'&&typeof descriptor.value==='function')methods.set(key,descriptor.value);
  function view(event){
    const data=states.get(event);if(!data)return event;
    if(!data.view){
      data.view=new Proxy(data.raw,{get(target,key,receiver){
        if(key==='isTrusted')return data.trusted;
        if(key==='target'&&data.target!==undefined)return data.target;
        if(data.parent){
          if(key==='eventPhase')return eventPhase.call(data.parent);
          if(key==='currentTarget')return dispatching(data)?data.target:null;
        }
        const own=Object.getOwnPropertyDescriptor(target,key),value=Reflect.get(target,key,own?receiver:target);
        if(typeof value!=='function'||methods.get(key)!==value)return value;
        if(key==='preventDefault'||key==='stopPropagation'||key==='stopImmediatePropagation'){
          if(!data.methods.has(value))data.methods.set(value,(...args)=>{
            if(key==='preventDefault'&&dispatching(data)&&data.passive)return;
            const result=Reflect.apply(value,target,args);
            if(key!=='preventDefault'&&data.parent&&data.parent!==target)Reflect.apply(value,data.parent,args);
            return result;
          });
          return data.methods.get(value);
        }
        if(key==='composedPath'&&data.target!==undefined){
          if(!data.path)data.path=()=>dispatching(data)?[data.target]:[];return data.path;
        }
        if(key==='initEvent'){
          if(!data.init)data.init=(...args)=>{
            if(dispatching(data))return Reflect.apply(value,new NativeEvent(''),args);
            const result=Reflect.apply(value,target,args);data.trusted=false;return result;
          };
          return data.init;
        }
        if(!data.methods.has(value))data.methods.set(value,value.bind(target));return data.methods.get(value);
      },set(target,key,value,receiver){
        if(key==='returnValue'&&!value){view(event).preventDefault();return true;}
        if(key==='cancelBubble'&&value){view(event).stopPropagation();return true;}
        return Reflect.set(target,key,value,receiver);
      }});
      states.set(data.view,data);
    }
    return data.view;
  }
  function wrap_listener(callback){
    if(callback===null||!['function','object'].includes(typeof callback))return callback;
    if(!listeners.has(callback))listeners.set(callback,function(event){
      if(typeof callback==='function')return Reflect.apply(callback,this,[view(event)]);
      return Reflect.apply(callback.handleEvent,callback,[view(event)]);
    });
    return listeners.get(callback);
  }
  function dispatch_event(event,dispatch,parent,target=globalThis){
    const data=state(event);if(data.delivered)throw invalid();
    if(parent){eventPhase.call(parent);data.parent=parent;data.target=target;states.set(parent,data);}
    data.delivered=true;data.trusted=true;data.dispatching=true;
    const ended=()=>{
      if(data.expired)return;
      if(dispatching(data)){data.timer=timeout(ended,0);return;}
      data.parent=null;data.dispatched.resolve();complete(data);
    };
    // Message delivery's native dispatch flag remains set through its callback
    // microtask checkpoint. Do not shorten that window to this JS call's stack.
    if(parent)data.timer=timeout(ended,0);
    try{dispatch(view(event),data.raw);}catch(error){data.errors.push(error);throw error;}finally{data.dispatching=false;if(!parent)ended();}
    return {event:view(event),lifetime:data.lifetime.promise,dispatched:data.dispatched.promise,get responded(){return !!data.responded;},get response(){return data.response?.promise||null;},get canceled(){return data.raw.defaultPrevented;}};
  }
  function finish_fetch(event,error){
    const data=fetch_state(event);if(!data.handledOwner)throw new TypeError('Not an internally completed FetchEvent');
    if(arguments.length>1)data.handledOwner.reject(error);else data.handledOwner.resolve();
  }
  function expire(event,reason=new DOMException('Service worker event timed out','TimeoutError')){
    const data=state(event);if(data.expired)return;
    data.expired=true;data.finished=true;clear_timeout(data.timer);data.parent=null;data.dispatched.reject(reason);data.lifetime.reject(reason);data.response?.reject(reason);data.handledOwner?.reject(reason);
    if(data.handle?.reader)upon(data.handle.reader.cancel(reason),undefined,()=>{});
  }
  function untrust(event,target){
    let data=states.get(event);
    if(data&&dispatching(data))throw invalid();
    if(!data&&target!==undefined){eventPhase.call(event);data={generic:true,raw:event,trusted:false,parent:event,methods:new Map()};states.set(event,data);}
    if(!data)return event;data.trusted=false;if(!data.generic)data.parent=null;if(target!==undefined)data.target=target;return data.raw;
  }
  function listener_options(event,{passive=false}={}){const data=states.get(event);if(data)data.passive=passive;}
  return {ExtendableEvent,FetchEvent,ExtendableMessageEvent,adopt,dispatch_event,finish_fetch,expire,view,wrap_listener,untrust,listener_options};
}
