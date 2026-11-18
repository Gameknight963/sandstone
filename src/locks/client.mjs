export function create_lock_api({open,query,Channel=globalThis.MessageChannel}){
  const token={},locks=new WeakMap(),managers=new WeakSet();
  class Lock {
    constructor(key,value){if(key!==token)throw new TypeError('Illegal constructor');locks.set(this,value);}
    get name(){const info=locks.get(this);if(!info)throw new TypeError('Invalid Lock receiver');return info.name;}
    get mode(){const info=locks.get(this);if(!info)throw new TypeError('Invalid Lock receiver');return info.mode;}
    get [Symbol.toStringTag](){return 'Lock';}
  }
  class LockManager {
    constructor(key){if(key!==token)throw new TypeError('Illegal constructor');managers.add(this);}
    async query(){if(!managers.has(this))throw new TypeError('Invalid LockManager receiver');return query();}
    async request(name,options,callback){
      if(!managers.has(this))throw new TypeError('Invalid LockManager receiver');
      if(arguments.length<2)throw new TypeError('Lock request requires a name and callback');
      name=`${name}`;
      if(arguments.length===2){callback=options;options={};}
      if(options!==undefined&&options!==null&&typeof options!=='object'&&typeof options!=='function')throw new TypeError('Invalid lock options');
      const ifAvailable=!!options?.ifAvailable,modeValue=options?.mode,mode=modeValue===undefined?'exclusive':`${modeValue}`,signal=options?.signal,steal=!!options?.steal;
      if(!['exclusive','shared'].includes(mode)||typeof callback!=='function')throw new TypeError('Invalid lock mode or callback');
      if(signal!==undefined)Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get.call(signal);
      if(name.startsWith('-')||steal&&(ifAvailable||mode!=='exclusive')||signal!==undefined&&(steal||ifAvailable))throw new DOMException('Unsupported lock options','NotSupportedError');
      if(signal?.aborted)throw signal.reason;
      const channel=new Channel(),port=channel.port1;
      return new Promise((resolve,reject)=>{
        let granted=false,settled=false,result;
        const cleanup=()=>{signal?.removeEventListener('abort',abort);port.close();};
        const abort=()=>{if(granted||settled)return;settled=true;reject(signal.reason);port.postMessage('cancel');};
        port.onmessage=event=>{
          const message=event.data;
          if(message.type==='granted'){
            if(settled){port.postMessage('cancel');return;}
            granted=true;signal?.removeEventListener('abort',abort);
            Promise.resolve().then(()=>callback(message.lock?new Lock(token,message.lock):null)).then(value=>{result={success:true,value};port.postMessage('release');},value=>{result={success:false,value};port.postMessage('release');});
          }else{
            cleanup();if(settled)return;settled=true;
            if(message.type==='error')reject(new DOMException(message.message,message.name));
            else if(result)(result.success?resolve:reject)(result.value);
          }
        };
        port.start();signal?.addEventListener('abort',abort,{once:true});
        Promise.resolve().then(()=>open(name,{mode,ifAvailable,steal},channel.port2)).catch(error=>{cleanup();channel.port2.close();if(!settled){settled=true;reject(error);}});
      });
    }
    get [Symbol.toStringTag](){return 'LockManager';}
  }
  return {Lock,LockManager,locks:new LockManager(token)};
}
