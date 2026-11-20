import {select_registration} from './registration.mjs';
import {trustworthy_url} from '../trustworthy.mjs';

// Bind before authored document scripts run. Document tokens, rather than
// reusable frame IDs, keep late registrations from controlling a replacement.
export class ServiceWorkerClients{
  constructor({manager,frames}){Object.assign(this,{manager,frames});}
  disconnect(frame){for(const client of this.manager.clients.values())if(client.frame===frame)this.manager.removeClient(client.id);}
  async bind(frame,signal){
    const frames=this.frames(),id=frame.document_context,origin=frame.origin||frame.url?.origin;
    if(!id||frame.service_worker_host||frames[frame.root_id]?.service_worker_host||frame.broadcast_origin?.startsWith('opaque:')||!origin||origin==='null')return null;
    if(!trustworthy_url(new URL(origin)))return null;
    // Blob URLs created inside the physical opaque sandbox have a null URL
    // origin. The authenticated worker frame retains its creator's origin.
    const blobWorker=frame.worker&&frame.url.protocol==='blob:'&&[origin,'null'].includes(frame.url.origin);
    const inherited=blobWorker||frame.url.protocol==='about:'&&['blank','srcdoc'].includes(frame.url.pathname)&&!frame.url.search;
    if(!inherited&&(!/^https?:$/.test(frame.url.protocol)||frame.url.origin!==origin))return null;
    const parent=this.manager.clients.get(frame.parent_context);
    const creationURL=inherited&&!blobWorker?frame.request_url||parent?.creationURL:frame.url.href;
    if(!creationURL||!blobWorker&&new URL(creationURL).origin!==origin)return null;
    const existing=this.manager.clients.get(id);
    if((existing?.navigation_committed||existing?.worker_committed)&&existing.frame===frame.id){if(existing.worker_committed)this.manager.notify?.({event:'clientready',client:existing});return existing;}
    const client=this.manager.addClient({id,frame:frame.id,url:frame.url.href,creationURL,origin,type:frame.worker?'worker':'window'});
    const current=()=>this.frames()[frame.id]===frame&&frame.document_context===id&&this.manager.clients.get(id)===client&&!signal?.aborted;
    const retire=()=>{if(this.manager.clients.get(id)===client)this.manager.removeClient(id);};
    signal?.addEventListener('abort',retire,{once:true});
    try{
      if(!current()){retire();return null;}
      if(inherited){
        if(parent?.controller&&!parent.registration?.revoked&&(parent.origin||new URL(parent.creationURL).origin)===origin)this.manager.control(client,parent.registration,parent.controller);
      }else{
        const records=await this.manager.list(origin);
        if(!current()){retire();return null;}
        const record=select_registration(records,creationURL,origin);
        if(record?.active&&!record.revoked&&!record.unregistered)this.manager.control(client,record,record.active);
      }
      return client;
    }catch(error){
      // A storage failure must not prevent an ordinary document from loading.
      if(current()){client.binding_error=error;return client;}retire();return null;
    }finally{signal?.removeEventListener('abort',retire);}
  }
}
