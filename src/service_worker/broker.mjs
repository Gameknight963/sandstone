import {create_bootstrap_nonce} from '../bootstrap.mjs';
import {select_registration} from './registration.mjs';
import {trustworthy_url} from '../trustworthy.mjs';

export class ServiceWorkerBroker{
  constructor({manager,frames,inspectWindow=async()=>({visibilityState:'visible',focused:false}),navigateWindow,id=create_bootstrap_nonce}){Object.assign(this,{manager,frames,inspectWindow,navigateWindow,id});this.subscribers=new Map();this.ids=new WeakMap();this.records=new Map();this.workers=new Map();this.mail=new Map();this.waiters=new Map();this.revision=0;}
  principal(id,token){
    const frame=this.frames()[id],client=this.manager.clients.get(token),origin=frame?.origin||frame?.url?.origin;
    if(!frame||frame.worker||frame.service_worker_host||this.frames()[frame.root_id]?.service_worker_host||frame.document_context!==token||client?.frame!==id||frame.broadcast_origin?.startsWith('opaque:')||!origin||origin==='null'||!trustworthy_url(new URL(origin)))throw new DOMException('Service worker client is unavailable','SecurityError');
    return {frame,client,origin};
  }
  describe(record){
    let id=this.ids.get(record);if(!id){id=this.id();this.ids.set(record,id);}this.records.set(id,record);
    for(const worker of [record.installing,record.waiting,record.active])if(worker)this.workers.set(worker.id,{record,worker});
    return {...this.manager.describe(record),id,unregistered:!!record.unregistered};
  }
  workerInfo(record,worker){if(!worker)return null;this.workers.set(worker.id,{record,worker});return {id:worker.id,scriptURL:worker.scriptURL,state:worker.state,type:worker.type,origin:record.origin};}
  snapshot(id,token){
    const {client,origin}=this.principal(id,token);
    const records=[...new Set([...this.records.values(),...this.manager.records.values(),...this.manager.retired])].filter(record=>record.origin===origin&&(record.active||record.waiting||record.installing||this.ids.has(record)));
    const registered=records.filter(record=>!record.unregistered&&!record.revoked),ready=select_registration(registered,client.creationURL,origin);
    return {revision:this.revision,registrations:records.map(record=>this.describe(record)),controller:this.workerInfo(client.registration,client.controller),ready:ready?.active?this.describe(ready).id:null,client:client.id};
  }
  async open(id,token,port){
    const {origin}=this.principal(id,token);await this.manager.list(origin);this.principal(id,token);
    this.subscribers.get(token)?.port.close();this.subscribers.set(token,{id,token,origin,port});port.start?.();
    const snapshot=this.snapshot(id,token);this.flush(token);return snapshot;
  }
  disconnect(frame){
    for(const [token,subscriber] of this.subscribers)if(subscriber.id===frame){subscriber.port.close();this.subscribers.delete(token);this.mail.delete(token);}
    for(const [token,queued] of this.mail)if(!this.manager.clients.has(token)){for(const message of queued)for(const port of message.ports||[])port.close();this.mail.delete(token);}
    for(const [token,waiters] of this.waiters)if(!this.manager.clients.has(token)){for(const resolve of waiters)resolve(undefined);this.waiters.delete(token);}
    const origins=new Set([...this.subscribers.values()].map(subscriber=>subscriber.origin));
    for(const [id,record] of this.records)if(!origins.has(record.origin))this.records.delete(id);
    for(const [id,entry] of this.workers)if(!origins.has(entry.record.origin))this.workers.delete(id);
  }
  notify(event){
    this.revision++;
    if(event.event==='clientgone'){const queued=this.mail.get(event.client.id);if(queued){for(const message of queued)for(const port of message.ports||[])port.close();this.mail.delete(event.client.id);}}
    if(event.client&&(event.event==='clientgone'||!event.client.reserved)){const waiters=this.waiters.get(event.client.id);if(waiters){for(const resolve of waiters)resolve(event.event==='clientgone'?undefined:event.client);this.waiters.delete(event.client.id);}}
    for(const subscriber of [...this.subscribers.values()]){
      try{
        const snapshot=this.snapshot(subscriber.id,subscriber.token);
        if(event.record&&event.record.origin!==subscriber.origin)continue;
        let type=event.event;if(type==='controllerchange'&&event.client.id!==subscriber.token)type='snapshot';
        subscriber.port.postMessage({type:'state',event:type,snapshot,registration:event.record?this.describe(event.record):null,worker:this.workerInfo(event.record,event.worker)});
      }catch{this.subscribers.delete(subscriber.token);subscriber.port.close();}
    }
  }
  async command(id,token,method,args){
    const {frame,client,origin}=this.principal(id,token);
    if(method==='register'){
      const record=await this.manager.register(args[0],args[1],{base:frame.request_url||frame.url.href,origin});this.principal(id,token);return this.describe(record);
    }
    if(method==='get'||method==='list'){
      const records=await this.manager.list(origin);this.principal(id,token);
      if(method==='list')return records.map(record=>this.describe(record));
      const url=new URL(args[0]);if(url.origin!==origin)throw new DOMException('Registration lookup must remain same-origin','SecurityError');
      const record=select_registration(records,url.href,origin);return record?this.describe(record):undefined;
    }
    if(method==='update'||method==='unregister'){
      const record=this.records.get(args[0]);if(!record||record.origin!==origin||record.revoked)throw new DOMException('Registration is unavailable','InvalidStateError');
      if(method==='unregister')return record.unregistered?false:this.manager.unregister(origin,record.scope);
      if(record.unregistered)throw new DOMException('Registration is unregistered','InvalidStateError');
      const worker=record.installing||record.waiting||record.active;
      await this.manager.register(worker.scriptURL,{scope:record.scope,type:worker.type,updateViaCache:record.updateViaCache},{base:frame.request_url||frame.url.href,origin});this.principal(id,token);return this.describe(record);
    }
    if(method==='post'){
      const entry=this.workers.get(args[0]);if(!entry||entry.record.origin!==origin||entry.record.revoked||entry.worker.state==='redundant')throw new DOMException('Worker is unavailable','InvalidStateError');
      const source=await this.clientInfo(client);if(!source)throw new DOMException('Client was discarded','InvalidStateError');
      const job=await this.manager.dispatch(entry.record,entry.worker,{event:'message',data:args[1].data,ports:args[1].ports,origin,source});await job.result;return;
    }
    throw new TypeError('Unknown service worker client operation');
  }
  async clientInfo(client){
    const frame=this.frames()[client.frame];if(!frame||frame.document_context!==client.id||this.manager.clients.get(client.id)!==client)return;
    let state;try{state=await this.inspectWindow(frame,client.id);}catch{return;}
    if(this.frames()[client.frame]!==frame||frame.document_context!==client.id||this.manager.clients.get(client.id)!==client)return;
    return {id:client.id,url:client.url,type:client.type||'window',frameType:frame.parent_id?'nested':'top-level',visibilityState:state.visibilityState,focused:!!state.focused};
  }
  eligible(record,client){return client&&new URL(client.creationURL).origin===record.origin;}
  async workerCommand(record,worker,method,args){
    this.manager.valid(record);
    if(method==='clients.get'){
      let client=this.manager.clients.get(args[0]);if(!this.eligible(record,client))return;
      if(client.reserved){client=await new Promise(resolve=>{let entries=this.waiters.get(args[0]);if(!entries)this.waiters.set(args[0],entries=[]);entries.push(resolve);});}
      return this.eligible(record,client)?this.clientInfo(client):undefined;
    }
    if(method==='clients.matchAll')return (await Promise.all([...this.manager.clients.values()].filter(client=>!client.reserved&&this.eligible(record,client)&&(args[0].includeUncontrolled||client.controller===worker)&&['all',client.type||'window'].includes(args[0].type)).map(client=>this.clientInfo(client)))).filter(Boolean);
    if(method==='client.navigate'){
      const client=this.manager.clients.get(args[0]),frame=this.frames()[client?.frame],url=new URL(args[1],worker.scriptURL);
      if(!this.eligible(record,client)||client.reserved||client.controller!==worker||!frame||frame.document_context!==client.id)throw new TypeError('Client is not controlled by this worker');
      if(!/^https?:$/.test(url.protocol))throw new TypeError('Unsupported client navigation URL');
      if(!this.navigateWindow)throw new DOMException('Client navigation is unavailable','NotSupportedError');
      const navigation=await this.navigateWindow(frame,url.href);
      this.manager.valid(record);
      if(navigation?.no_navigation||navigation?.download||navigation?.failed)throw new TypeError('Client navigation did not create a document');
      const nextFrame=this.frames()[frame.id],next=this.manager.clients.get(nextFrame?.document_context);
      if(!navigation?.document_context||nextFrame?.document_context!==navigation.document_context)throw new TypeError('Client navigation was superseded');
      if(!this.eligible(record,next))return null;
      return await this.clientInfo(next)||null;
    }
    if(method==='client.postMessage'){
      const client=this.manager.clients.get(args[0]);if(!this.eligible(record,client))return;
      let queued=this.mail.get(client.id);if(!queued)this.mail.set(client.id,queued=[]);
      queued.push({type:'message',data:args[1].data,ports:args[1].ports,origin:record.origin,source:this.workerInfo(record,worker)});this.flush(client.id);return;
    }
    throw new DOMException('Service worker client operation is unavailable','NotSupportedError');
  }
  flush(token){const subscriber=this.subscribers.get(token),queued=this.mail.get(token);if(!subscriber||!queued)return;this.mail.delete(token);for(const message of queued)subscriber.port.postMessage(message,message.ports);}
}
