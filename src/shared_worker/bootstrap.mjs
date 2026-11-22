import {create_bootstrap_nonce} from '../bootstrap.mjs';

// Runs only in the opaque native actor. Capture intrinsics before authored
// scripts can change their globals or MessageEvent/MessagePort prototypes.
function actor_main(nonce){
  const scope=globalThis,apply=Reflect.apply,post=MessagePort.prototype.postMessage,start=MessagePort.prototype.start,end=MessagePort.prototype.close;
  const getData=Object.getOwnPropertyDescriptor(MessageEvent.prototype,'data').get,getPorts=Object.getOwnPropertyDescriptor(MessageEvent.prototype,'ports').get;
  const stop=Event.prototype.stopImmediatePropagation,nativeClose=scope.close.bind(scope),string=String;
  const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);let instance='';for(const byte of bytes)instance+=byte.toString(16).padStart(2,'0');
  let phase='bootstrap',control;const candidates=new Set();
  const send=(port,message)=>apply(post,port,[{sandstone_actor:nonce,instance,...message}]);
  const receiveControl=event=>{
    const message=apply(getData,event,[]);for(const port of apply(getPorts,event,[]))apply(end,port,[]);
    if(message?.sandstone_actor!==nonce||message.instance!==instance||message.type!=='terminate')return;
    send(control,{type:'closed'});apply(post,control,[{sandstone_worker:instance,type:'closed'}]);nativeClose();
  };
  const initialize=async(port,event)=>{
    const message=apply(getData,event,[]),ports=apply(getPorts,event,[]);
    if(message?.sandstone_actor!==nonce||message.instance!==instance||message.type!=='initialize'||phase!=='bootstrap'){
      for(const port of ports)apply(end,port,[]);return;
    }
    if(typeof message.runtime!=='string'||!message.options||!ports[0]){
      for(const port of ports)apply(end,port,[]);send(port,{type:'invalid-initialization'});return;
    }
    phase='initializing';control=port;control.onmessage=receiveControl;
    for(const candidate of candidates)if(candidate!==control)apply(end,candidate,[]);candidates.clear();
    for(const extra of ports.slice(1))apply(end,extra,[]);
    try{
      scope.__sandstone_bootstrap__={nonce,channels:1};(0,eval)(message.runtime);
      await scope.sandstone_frame.worker.initialize_shared_worker({...message.options,token:instance},ports[0],control,nonce);
      phase='ready';send(control,{type:'ready'});
    }catch(error){send(control,{type:'scope-error',name:string(error.name||'Error'),message:string(error.message||error)});nativeClose();}
  };
  scope.addEventListener('connect',event=>{
    if(!event.isTrusted)return;
    const port=apply(getPorts,event,[])[0];if(!port)return;
    send(port,{type:'hello',phase});
    if(phase==='ready')return;
    apply(stop,event,[]);
    if(phase!=='bootstrap'){apply(end,port,[]);return;}
    candidates.add(port);port.onmessage=event=>initialize(port,event);apply(start,port,[]);
  },true);
}

export function actor_profile(){
  const nonce=create_bootstrap_nonce();
  return {nonce,url:'data:text/javascript,'+encodeURIComponent('('+actor_main.toString()+')('+JSON.stringify(nonce)+');')};
}
