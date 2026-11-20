import {parse_referrer_policy,request_referrer} from '../referrer.mjs';
import {remember_response} from '../response_metadata.mjs';
import {redirect_url} from '../redirect.mjs';

// Runs before the HTTP cookie/cache pipeline. A worker's own fetches bypass
// this dispatcher, while synthetic redirects re-enter it for the same client.
export class ServiceWorkerFetch{
  constructor({manager,client}){Object.assign(this,{manager,client});}
  async fetch(input,options={},context={},network,depth=0){
    const client=this.client(context),worker=client?.controller,record=client?.registration;
    if(context.service_worker_bypass||context.navigation&&!context.service_worker_navigation||!worker||!record||record.revoked)return network(input,options,context);
    const url=new URL(input),signal=options.signal;
    if(!/^https?:$/.test(url.protocol))return network(input,options,context);
    signal?.throwIfAborted();
    if(options.mode==='same-origin'&&(context.broadcast_origin?.startsWith('opaque:')||new URL(context.url).origin!==url.origin))throw new TypeError('Cross-origin request with same-origin mode');
    const headers=new Headers(options.headers);
    for(const key of [...headers.keys()])if(/^(cookie2?|origin|referer|host|sec-.*)$/i.test(key))headers.delete(key);
    const policy=parse_referrer_policy(options.referrerPolicy||context.referrerPolicy);
    const referrer=context.broadcast_origin?.startsWith('opaque:')||options.referrer===''?'':request_referrer(options.referrer&&options.referrer!=='about:client'?options.referrer:context.referrer_url??context.url,url.href,policy);
    const request={url:url.href,method:options.method||'GET',headers:[...headers],mode:options.mode||'no-cors',credentials:options.credentials||'include',redirect:options.redirect||'follow',cache:options.cache||'default',referrerPolicy:policy,virtualReferrer:referrer,destination:options.destination||'',...(options.body===undefined?{}:{body:options.body})};
    let job,aborted=false,rejectAbort,streamController;
    const abortPromise=new Promise((_,reject)=>{rejectAbort=reject;});abortPromise.catch(()=>{});
    const safely=callback=>Promise.resolve().then(callback).catch(()=>{});
    const stop=reason=>{if(!job)return;void safely(()=>job.abort(reason));void safely(()=>job.cancel(reason));void safely(()=>job.handled(reason));};
    const abort=()=>{
      aborted=true;request.aborted=true;
      const reason=signal.reason;rejectAbort(reason);streamController?.error(reason);stop(reason);
    };
    const cleanup=()=>signal?.removeEventListener('abort',abort);
    const race=operation=>Promise.race([operation,abortPromise]);
    signal?.addEventListener('abort',abort,{once:true});
    try{
      const starting=Promise.resolve(this.manager.dispatch(record,worker,{event:'fetch',request,request_context:context,clientId:context.service_worker_entry?context.service_worker_entry_parent:context.navigation?context.navigation_previous||'':client.id,resultingClientId:context.navigation||context.service_worker_entry?client.id:''},{waitHandled:true})).then(value=>{job=value;if(aborted)stop(signal.reason);return value;});
      job=await race(starting);
      const result=await race(job.result);
      if(result.type==='fallback'){
        const response=await race(network(input,options,context));
        await job.handled();cleanup();return response;
      }
      if(result.type!=='response')throw new TypeError('Invalid service worker response');
      // A filtered response returned by respondWith still carries its private
      // redirect headers and body for the browser's navigation pipeline.
      const metadata=result.metadata.type==='opaqueredirect'&&result.metadata.internal_response?result.metadata.internal_response:result.metadata,responseHeaders=new Headers(metadata.headers);
      responseHeaders.delete('set-cookie');responseHeaders.delete('set-cookie2');
      const hasBody=result.body&&request.method.toUpperCase()!=='HEAD';
      const body=hasBody?new ReadableStream({
        start(controller){streamController=controller;},
        async pull(controller){
          try{const chunk=await race(job.read());if(aborted)return;if(chunk.done){cleanup();controller.close();}else controller.enqueue(chunk.value);}
          catch(error){cleanup();if(!aborted)controller.error(error);void safely(()=>job.cancel(error));}
        },
        cancel(reason){cleanup();return job.cancel(reason);}
      },{highWaterMark:0}):null;
      if(result.body&&!hasBody)await job.cancel();
      const response=new Response(body,{status:metadata.status||200,statusText:metadata.statusText,headers:responseHeaders});
      const responseURL=context.navigation?url.href:metadata.url||url.href;
      for(const [key,value] of Object.entries({url:responseURL,type:metadata.type||'default',redirected:!!metadata.redirected,...(metadata.status===0?{status:0,ok:false}:{})}))Object.defineProperty(response,key,{value,configurable:true});
      remember_response(response,{...metadata,url:responseURL});
      await job.handled();if(!hasBody)cleanup();
      const location=responseHeaders.get('location');
      if(location&&[301,302,303,307,308].includes(metadata.status)){
        // The internal transport remains unfiltered. The page/worker fetch API
        // applies its opaque-redirect filter after receiving this response.
        if(request.redirect==='manual'&&!context.navigation&&!context.service_worker_entry)return response;
        await response.body?.cancel();cleanup();
        if(request.redirect==='error')throw new TypeError('Redirect disallowed');
        if(context.navigation||context.service_worker_entry)return response;
        if(depth===20)throw new TypeError('Too many redirects');
        const next=redirect_url(location,url);
        if(next.username||next.password)throw new TypeError('Invalid redirect URL');
        const init={...options,headers:new Headers(options.headers),referrerPolicy:parse_referrer_policy(responseHeaders.get('referrer-policy'),policy),referrer};
        if(next.origin!==url.origin)for(const key of ['authorization','proxy-authorization','cookie'])init.headers.delete(key);
        if(metadata.status===303&&!/^(GET|HEAD)$/i.test(request.method)||[301,302].includes(metadata.status)&&/^POST$/i.test(request.method)){
          init.method='GET';delete init.body;
          for(const key of ['content-type','content-length','content-encoding','content-language','content-location'])init.headers.delete(key);
        }
        const following=await this.fetch(next.href,init,context,network,depth+1);
        // Network responses have non-configurable metadata; wrap the body.
        const output=new Response(following.body,{status:following.status||200,statusText:following.statusText,headers:following.headers});
        for(const key of ['url','type','request_referrer','request_cross_origin','request_metadata'])if(following[key]!==undefined)Object.defineProperty(output,key,{value:following[key]});
        Object.defineProperty(output,'redirected',{value:true});
        if(following.status===0)Object.defineProperties(output,{status:{value:0},ok:{value:false}});
        return remember_response(output,{status:following.status,type:following.type,url:following.url,redirected:true});
      }
      return response;
    }catch(error){
      cleanup();if(job){void safely(()=>job.handled(error));void safely(()=>job.cancel(error));}throw error;
    }
  }
}
