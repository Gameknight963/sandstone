import {cookie_header} from './cookie_policy.mjs';
import {snapshot_request_context} from './request.mjs';

// This endpoint belongs on a private, trusted host channel. It is deliberately
// not an authored-worker RPC: responses may contain HttpOnly cookie values.
export function cookie_policy_handler(store){
  return async message=>{
    if(message.op==='capture'){
      const {cookieGeneration,cookieEpochs}=snapshot_request_context(store,message.context);
      await store.ready;
      return {cookieGeneration,cookieEpochs};
    }
    await store.ready;
    store.refresh?.();
    if(message.op==='header')return cookie_header(store.cookies,message.url,message.options);
    if(message.op==='set'){store.setCookie(message.url,message.value,true,message.options);return;}
    throw new TypeError('Unknown cookie policy operation');
  };
}

function call(request,message,signal){
  signal?.throwIfAborted();
  let abort;
  return new Promise((resolve,reject)=>{
    abort=()=>reject(signal.reason);
    signal?.addEventListener('abort',abort,{once:true});
    // Start the policy operation now and always observe late replies/rejections.
    // The private channel can also use the signal to discard its pending call.
    try{Promise.resolve(request(message,{signal})).then(resolve,reject);}
    catch(error){reject(error);}
  }).finally(()=>signal?.removeEventListener('abort',abort));
}

export class CookiePolicyBridge {
  constructor(request){if(typeof request!=='function')throw new TypeError('A trusted cookie policy channel is required');this.request=request;}
  captureCookieContext(context,signal){
    return call(this.request,{op:'capture',context:{cookieGeneration:context.cookieGeneration,cookieEpochs:context.cookieEpochs}},signal);
  }
  cookieHeader(url,options,signal){return call(this.request,{op:'header',url,options},signal);}
  setCookie(url,value,http,options,signal){return call(this.request,{op:'set',url,value,options},signal);}
}
