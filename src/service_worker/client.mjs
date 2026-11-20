import {normalize_registration} from './registration.mjs';
import {snapshot_message} from './messages.mjs';
import {create_service_worker_events} from './events.mjs';
import {create_service_worker_dispatcher} from './dispatcher.mjs';

const targets=new WeakMap();let patched=false;
function patch_borrowed_events(){
  if(patched)return;patched=true;
  for(const key of ['addEventListener','removeEventListener','dispatchEvent']){
    const descriptor=Object.getOwnPropertyDescriptor(EventTarget.prototype,key),original=descriptor.value;
    const value=new Proxy(original,{apply(method,receiver,args){const target=targets.get(receiver);return target?target[key](...args):Reflect.apply(method,receiver,args);}});
    Object.defineProperty(EventTarget.prototype,key,{...descriptor,value});
  }
}

export function create_service_worker_client({command,base,origin,encode=value=>value}){
  patch_borrowed_events();
  const token={},workers=new Map(),registrations=new Map(),states=new WeakMap(),events=create_service_worker_events(),dispatchers=new Set();
  const holders=new Map(),held=[],messages=[];let revision=-1,controller=null,started=false,closed=false,resolveReady;
  const ready=new Promise(resolve=>resolveReady=resolve);
  const state=(value,kind)=>{const info=states.get(value);if(!info||info.kind!==kind)throw new TypeError('Illegal '+kind+' receiver');return info;};
  const initialize=(value,kind,info)=>{
    const dispatcher=create_service_worker_dispatcher({events,target:value,types:['controllerchange','statechange','updatefound','message','messageerror','error']});
    states.set(value,{...info,kind,dispatcher,handlers:new Map()});targets.set(value,dispatcher);dispatchers.add(dispatcher);
  };
  const emit=(target,event)=>{if(!closed)void states.get(target).dispatcher.deliver(events.adopt(event)).catch(()=>{});};
  function worker(info){
    if(!info)return null;
    let value=workers.get(info.id);if(!value){value=new ServiceWorker(token,info);workers.set(info.id,value);}else Object.assign(states.get(value).info,info);
    return value;
  }
  function registration(info){
    if(!info)return undefined;
    let value=registrations.get(info.id);if(!value){value=new ServiceWorkerRegistration(token,info);registrations.set(info.id,value);}
    const data=states.get(value);data.info={...info};for(const key of ['installing','waiting','active'])data[key]=worker(info[key]);return value;
  }
  function apply(snapshot){
    if(!snapshot||snapshot.revision<revision)return false;revision=snapshot.revision;
    for(const info of snapshot.registrations)registration(info);
    controller=worker(snapshot.controller);
    if(snapshot.ready&&registrations.has(snapshot.ready))resolveReady(registrations.get(snapshot.ready));
    return true;
  }
  async function call(method,args=[],ports=[]){const result=await command(method,args,ports);apply(result.snapshot);return result.value;}
  async function hold(scope,operation){
    holders.set(scope,(holders.get(scope)||0)+1);
    try{return await operation();}finally{
      const remaining=holders.get(scope)-1;if(remaining)holders.set(scope,remaining);else holders.delete(scope);
      setTimeout(()=>{for(let index=0;index<held.length;){const packet=held[index];if(!holders.has(packet.registration?.scope)){held.splice(index,1);deliverState(packet);}else index++;}},0);
    }
  }
  function deliverState(packet){
    if(packet.event==='statechange'&&packet.worker&&workers.has(packet.worker.id))emit(workers.get(packet.worker.id),new Event('statechange'));
    if(packet.event==='updatefound'&&packet.registration){const target=registrations.get(packet.registration.id);if(target)emit(target,new Event('updatefound'));}
    if(packet.event==='controllerchange')emit(container,new Event('controllerchange'));
  }
  function deliverMessage(packet){
    const source=packet.source?(workers.get(packet.source.id)||worker(packet.source)):null,event=new MessageEvent(packet.type,{data:packet.data,origin:packet.origin,ports:packet.ports||[]});
    Object.defineProperty(event,'source',{value:source});emit(container,event);
  }
  function receive(packet){
    if(closed)return;
    if(packet.type==='state'){
      const known=packet.worker&&workers.has(packet.worker.id),updated=apply(packet.snapshot);
      if(updated&&packet.worker)worker(packet.worker);
      if(packet.event==='statechange'&&!known)return;
      if(holders.has(packet.registration?.scope))held.push(packet);else deliverState(packet);
    }else if(packet.type==='message'||packet.type==='messageerror'){
      if(started)deliverMessage(packet);else messages.push(packet);
    }
  }
  class ServiceWorker extends EventTarget{
    constructor(secret,info){super();if(secret!==token)throw new TypeError('Illegal constructor');initialize(this,'ServiceWorker',{info:{...info}});}
    get scriptURL(){return state(this,'ServiceWorker').info.scriptURL;}
    get state(){return state(this,'ServiceWorker').info.state;}
    postMessage(message,options){
      const info=state(this,'ServiceWorker').info;if(!arguments.length)throw new TypeError('A message is required');
      if(info.state==='redundant')throw new DOMException('Worker is redundant','InvalidStateError');
      const snapshot=snapshot_message(message,options,encode);void call('post',[info.id,snapshot],snapshot.ports).catch(()=>{});
    }
  }
  class ServiceWorkerRegistration extends EventTarget{
    constructor(secret,info){super();if(secret!==token)throw new TypeError('Illegal constructor');initialize(this,'ServiceWorkerRegistration',{info});}
    get scope(){return state(this,'ServiceWorkerRegistration').info.scope;}
    get updateViaCache(){return state(this,'ServiceWorkerRegistration').info.updateViaCache;}
    get installing(){return state(this,'ServiceWorkerRegistration').installing;}
    get waiting(){return state(this,'ServiceWorkerRegistration').waiting;}
    get active(){return state(this,'ServiceWorkerRegistration').active;}
    async update(){const data=state(this,'ServiceWorkerRegistration');return hold(data.info.scope,async()=>{const info=await call('update',[data.info.id]);return registrations.get(info.id)||registration(info);});}
    async unregister(){return call('unregister',[state(this,'ServiceWorkerRegistration').info.id]);}
  }
  class ServiceWorkerContainer extends EventTarget{
    constructor(secret){super();if(secret!==token)throw new TypeError('Illegal constructor');initialize(this,'ServiceWorkerContainer',{});}
    get controller(){state(this,'ServiceWorkerContainer');return controller;}
    get ready(){state(this,'ServiceWorkerContainer');return ready;}
    async register(scriptURL,options={}){
      state(this,'ServiceWorkerContainer');if(!arguments.length)throw new TypeError('A service worker script URL is required');
      const info=normalize_registration(scriptURL,options,{base:base(),origin:origin()});
      return hold(info.scope,async()=>{const value=await call('register',[info.scriptURL,{scope:info.scope,type:info.type,updateViaCache:info.updateViaCache}]);return registrations.get(value.id)||registration(value);});
    }
    async getRegistration(clientURL=''){
      state(this,'ServiceWorkerContainer');const url=new URL(`${clientURL}`,base());if(url.origin!==origin())throw new DOMException('Registration lookup must remain same-origin','SecurityError');
      const info=await call('get',[url.href]);return info?registrations.get(info.id)||registration(info):undefined;
    }
    async getRegistrations(){state(this,'ServiceWorkerContainer');return (await call('list')).map(info=>registrations.get(info.id)||registration(info));}
    startMessages(){state(this,'ServiceWorkerContainer');started=true;for(const packet of messages.splice(0))deliverMessage(packet);}
  }
  for(const [constructor,kind,names] of [[ServiceWorker,'ServiceWorker',['statechange','error']],[ServiceWorkerRegistration,'ServiceWorkerRegistration',['updatefound']],[ServiceWorkerContainer,'ServiceWorkerContainer',['controllerchange','message','messageerror']]]){
    Object.defineProperty(constructor,'name',{value:kind});Object.defineProperty(constructor.prototype,Symbol.toStringTag,{value:kind,configurable:true});
    for(const type of names)Object.defineProperty(constructor.prototype,'on'+type,{configurable:true,enumerable:true,get(){return state(this,kind).handlers.get(type)?.value||null;},set(value){
      const info=state(this,kind);let handler=info.handlers.get(type);
      if(!handler){handler={value:null};handler.callback=event=>{if(handler.value)Reflect.apply(handler.value,this,[event]);};info.handlers.set(type,handler);}
      if(typeof value==='function'){if(!handler.value)this.addEventListener(type,handler.callback);handler.value=value;if(type==='message'&&kind==='ServiceWorkerContainer')this.startMessages();}
      else{if(handler.value)this.removeEventListener(type,handler.callback);handler.value=null;}
    }});
  }
  const container=new ServiceWorkerContainer(token);
  return {ServiceWorker,ServiceWorkerRegistration,ServiceWorkerContainer,container,apply,receive,snapshot:()=>({controller:controller?{...states.get(controller).info}:null}),close(){closed=true;for(const dispatcher of dispatchers)dispatcher.destroy();dispatchers.clear();messages.length=0;held.length=0;}};
}
