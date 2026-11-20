import {create_bootstrap_nonce} from '../bootstrap.mjs';
import {select_registration} from './registration.mjs';
import {trustworthy_url} from '../trustworthy.mjs';

// Worker scripts create clients without document navigations. Keep their
// controller alive while the entry body is read and the worker is installed.
export class ServiceWorkerWorkerRequests{
  constructor({manager,frames,route,id=create_bootstrap_nonce,timeout=120000}){
    Object.assign(this,{manager,frames,route,id,timeout});this.pending=new Map();this.responses=new WeakMap();
  }
  response(response){return this.responses.get(response)?.client.id;}
  reserved(token){return [...this.pending.values()].some(lease=>lease.client.id===token);}
  cancel(owner,target,document){const lease=this.pending.get(target);if(lease?.owner===owner&&lease.document===document)lease.release();}
  disconnect(frame){for(const lease of [...this.pending.values()])if(lease.owner===frame||lease.target===frame)lease.release();}
  commit(frame,token){
    if(!token)return;
    const lease=this.pending.get(frame.id),parent=this.frames()[frame.parent_id];
    if(!frame.worker||!lease||lease.client.id!==token||lease.owner!==frame.parent_id||lease.document!==parent?.document_context||lease.url!==frame.url.href||this.frames()[frame.id]!==frame||this.manager.clients.get(token)!==lease.client){
      if(lease?.client.id===token&&lease.owner===frame.parent_id)lease.release();
      throw new DOMException('Worker entry was superseded','AbortError');
    }
    lease.complete();Object.assign(lease.client,{frame:frame.id,url:frame.url.href,creationURL:frame.url.href,origin:frame.origin,worker_committed:true});return token;
  }
  async fetch(input,options,context,network){
    const owner=this.frames()[context.frame_id],target=context.worker_entry_target;
    if(context.service_worker_bypass||!owner||owner.service_worker_host||this.frames()[owner.root_id]?.service_worker_host)return network(input,options,context);
    if(typeof target!=='string'||!target||this.frames()[target])throw new TypeError('Invalid worker entry target');
    const previous=this.pending.get(target);
    if(previous&&(previous.owner!==owner.id||previous.document!==owner.document_context))throw new DOMException('Worker entry belongs to another document','SecurityError');
    previous?.release();
    const controller=new AbortController(),signal=controller.signal,client=this.manager.addClient({id:this.id(),url:input,creationURL:input,type:'worker',reserved:true});
    const lease={client,owner:owner.id,document:owner.document_context,target,url:input};
    let finished=false,timer;
    const cleanup=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);if(this.pending.get(target)===lease)this.pending.delete(target);};
    lease.complete=()=>{if(finished)return;finished=true;cleanup();client.reserved=false;};
    lease.release=(reason=new DOMException('Worker entry was canceled','AbortError'))=>{if(finished)return;finished=true;cleanup();this.manager.removeClient(client.id);controller.abort(reason);};
    const abort=()=>lease.release(options.signal.reason);
    timer=setTimeout(()=>lease.release(new DOMException('Worker entry did not commit','TimeoutError')),this.timeout);timer.unref?.();
    this.pending.set(target,lease);options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
    const wait=async operation=>{signal.throwIfAborted();let stop;const aborted=new Promise((_,reject)=>{stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true});});try{return await Promise.race([operation,aborted]);}finally{signal.removeEventListener('abort',stop);}};
    try{
      const response=await wait(network(input,{...options,signal},context,async(url,init)=>{
        signal.throwIfAborted();const destination=new URL(url),origin=owner.origin||owner.url.origin;
        const records=trustworthy_url(destination)&&destination.origin===origin&&!owner.broadcast_origin?.startsWith('opaque:')?await wait(this.manager.list(origin)):[];
        signal.throwIfAborted();const record=select_registration(records,url,destination.origin),worker=record?.active,old=client.registration;
        Object.assign(client,{url,creationURL:url});this.manager.control(client,worker?record:null,worker||null);
        if(old&&old!==record){this.manager.requestActivation(old);this.manager.collect(old);}
        if(worker)return this.route(url,{...init,destination:'worker'},{...context,service_worker_entry:client,service_worker_entry_parent:owner.document_context},async()=>undefined);
      }).then(response=>{if(signal.aborted){void response.body?.cancel().catch(()=>{});signal.throwIfAborted();}return response;}));
      signal.throwIfAborted();lease.url=response.url||input;
      const reader=response.body?.getReader();let bodyController;
      const detach=()=>signal.removeEventListener('abort',stopBody);
      const stopBody=()=>{bodyController?.error(signal.reason);void reader?.cancel(signal.reason).catch(()=>{});detach();};
      const body=reader?new ReadableStream({
        start(controller){bodyController=controller;signal.addEventListener('abort',stopBody,{once:true});},
        async pull(controller){try{const result=await wait(reader.read());if(signal.aborted)return;if(result.done){detach();controller.close();}else controller.enqueue(result.value);}catch(error){detach();if(!signal.aborted)controller.error(error);lease.release(error);}},
        cancel(reason){detach();lease.release(reason);return reader.cancel(reason);}
      },{highWaterMark:0}):null;
      const output=new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
      for(const key of ['url','type','redirected','request_referrer','request_cross_origin','request_metadata'])if(response[key]!==undefined)Object.defineProperty(output,key,{value:response[key]});
      this.responses.set(output,lease);return output;
    }catch(error){lease.release(error);throw error;}
  }
}
