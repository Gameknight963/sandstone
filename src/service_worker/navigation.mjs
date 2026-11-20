import {create_bootstrap_nonce} from '../bootstrap.mjs';
import {trustworthy_url} from '../trustworthy.mjs';
import {select_registration} from './registration.mjs';
import {is_download} from '../download.mjs';

function wait(operation,signal){
  signal.throwIfAborted();let abort;
  const canceled=new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
  return Promise.race([operation,canceled]).finally(()=>signal.removeEventListener('abort',abort));
}

// Reserve the incoming document independently of the frame being replaced.
// A response body can finish before runtime installation; the reservation
// keeps its selected controller alive until the authenticated document commits.
export class ServiceWorkerNavigations{
  constructor({manager,frames,route,id=create_bootstrap_nonce,timeout=120000}){
    Object.assign(this,{manager,frames,route,id,timeout});this.pending=new Map();this.responses=new WeakMap();
  }
  response(response){return this.responses.get(response);}
  reserved(id){return [...this.pending.values()].some(lease=>lease.client.id===id);}
  cancel(target,owner,document){const lease=this.pending.get(target);if(lease&&lease.owner===owner&&lease.owner_context===document)lease.release();}
  disconnect(frame,{keep_navigation=false}={}){
    for(const lease of [...this.pending.values()])if(lease.owner===frame&&lease.target!==frame||lease.target===frame&&!keep_navigation)lease.release();
  }
  commit(frame,lease){
    if(!lease)return;
    const owner=this.frames()[lease.owner];
    if(!owner||this.frames()[frame.id]!==frame||this.pending.get(frame.id)!==lease||lease.url!==frame.url.href||owner.document_context!==lease.owner_context||this.manager.clients.get(lease.client.id)!==lease.client){lease.release();return;}
    if(!trustworthy_url(frame.url)||frame.broadcast_origin?.startsWith('opaque:')){lease.release();return;}
    lease.complete();Object.assign(lease.client,{frame:frame.id,url:frame.url.href,creationURL:frame.url.href,navigation_committed:true});return lease.client.id;
  }
  reserve(input,context,signal){
    this.pending.get(context.navigation_target)?.release();
    const controller=new AbortController(),client=this.manager.addClient({id:this.id(),url:input,creationURL:input,type:'window',reserved:true});
    const lease={client,target:context.navigation_target,owner:context.navigation_owner,owner_context:this.frames()[context.navigation_owner]?.document_context,controller,url:input};
    let finished=false,timer;
    const detach=()=>{clearTimeout(timer);signal?.removeEventListener('abort',aborted);if(this.pending.get(lease.target)===lease)this.pending.delete(lease.target);};
    lease.complete=()=>{if(finished)return;finished=true;detach();client.reserved=false;};
    lease.release=(reason=new DOMException('Navigation was canceled','AbortError'),abort=true)=>{if(finished)return;finished=true;detach();this.manager.removeClient(client.id);if(abort)controller.abort(reason);};
    const aborted=()=>lease.release(signal.reason);
    timer=setTimeout(()=>lease.release(new DOMException('Navigation did not commit','TimeoutError')),this.timeout);timer.unref?.();
    signal?.addEventListener('abort',aborted,{once:true});this.pending.set(lease.target,lease);
    if(signal?.aborted)aborted();return lease;
  }
  async fetch(input,options={},context={},network){
    const owner=this.frames()[context.navigation_owner],target=this.frames()[context.navigation_target];
    if(context.service_worker_bypass||!context.navigation_target||!owner||owner.service_worker_host||this.frames()[owner.root_id]?.service_worker_host||target?.worker||context.navigation_opaque)return network(input,options,context);
    const lease=this.reserve(input,context,options.signal),signal=lease.controller.signal;
    try{
      const response=await wait(network(input,{...options,signal},context,async(url,init)=>{
        signal.throwIfAborted();const destination=new URL(url);
        const records=trustworthy_url(destination)?await wait(this.manager.list(destination.origin),signal):[];
        const record=select_registration(records,url,destination.origin),worker=record?.active;
        const previous=lease.client.registration;
        Object.assign(lease.client,{url,creationURL:url});
        this.manager.control(lease.client,worker?record:null,worker||null);
        if(previous&&previous!==record){this.manager.requestActivation(previous);this.manager.collect(previous);}
        if(!worker)return;
        return this.route(url,{...init,destination:context.nested?'iframe':'document'},{...context,service_worker_navigation:lease.client},async()=>undefined);
      }).then(response=>{if(signal.aborted){void response.body?.cancel().catch(()=>{});signal.throwIfAborted();}return response;}),signal);
      signal.throwIfAborted();lease.url=response.url||input;
      const noContent=[204,205].includes(response.status),download=is_download(response.headers),reader=response.body?.getReader();
      let bodyController;
      const cleanup=()=>signal.removeEventListener('abort',stopBody);
      const stopBody=()=>{bodyController?.error(signal.reason);void reader?.cancel(signal.reason).catch(()=>{});cleanup();};
      const body=reader?new ReadableStream({
        start(controller){bodyController=controller;signal.addEventListener('abort',stopBody,{once:true});},
        async pull(controller){try{const result=await wait(reader.read(),signal);if(signal.aborted)return;if(result.done){cleanup();controller.close();if(download)lease.release(undefined,false);}else controller.enqueue(result.value);}catch(error){cleanup();if(!signal.aborted)controller.error(error);lease.release(error);}},
        cancel(reason){cleanup();lease.release(reason);return reader.cancel(reason);}
      },{highWaterMark:0}):null;
      const output=new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
      for(const key of ['url','type','redirected','request_referrer','request_cross_origin','request_metadata'])if(response[key]!==undefined)Object.defineProperty(output,key,{value:response[key]});
      if(download||noContent){if(!reader)lease.release(undefined,false);}else this.responses.set(output,lease);
      return output;
    }catch(error){lease.release(error);throw error;}
  }
}
