import {iframes} from './controller.mjs';
import {beacons,clean_ws_connections} from './network.mjs';
import {indexed_db} from './indexeddb.mjs';
import {crypto_service} from './crypto.mjs';
import {WorkerRPCPolicy} from './worker_policy.mjs';
import {create_bootstrap_nonce} from '../bootstrap.mjs';
import * as rpc from '../rpc.mjs';

// Trusted hosts may retain a worker independently of any renderer document.
// Only its bound port can address this context; document/navigation procedures
// and further port attachment are unavailable to the remote worker.
export class WorkerServiceHost {
  constructor({url,top_url=url,cross_site=false,referrer_policy}={},port){
    const script=new URL(url),top=new URL(top_url);
    if(!['http:','https:'].includes(script.protocol)||!['http:','https:'].includes(top.protocol))throw new TypeError('HTTP worker and top-level URLs are required');
    if(!(port instanceof MessagePort))throw new TypeError('A worker MessagePort is required');
    const rootId='worker-owner:'+create_bootstrap_nonce(),id='worker:'+create_bootstrap_nonce();
    const rootContext=beacons.register(rootId,{url:top.href,top_url:top.href,root_id:rootId,broadcast_origin:top.origin});
    const token=beacons.register(id,{url:script.href,top_url:top.href,root_id:rootId,broadcast_origin:script.origin,cross_site:!!cross_site,referrerPolicy:referrer_policy});
    this.id=id;this.rootId=rootId;this.port=port;
    this.profile={url:script.href,origin:script.origin,frame_id:id,beacon_context:token,referrer_policy,crypto_available:crypto_service.methods};
    const root={id:rootId,root_id:rootId,url:top,origin:top.origin,document_context:rootContext,
      // The metadata owner is not a document. In particular it must never
      // receive top-level cookies on the remote worker's port.
      rpc_target:{target:null,extra_frame_targets:new Map([[id,port]])}};
    const frame={id,root_id:rootId,parent_id:rootId,parent_context:rootContext,worker:true,url:script,origin:script.origin,broadcast_origin:script.origin,document_context:token,retained_cross_site:!!cross_site};
    iframes[rootId]=root;iframes[id]=frame;
    const policy=new WorkerRPCPolicy({root:rootId,frames:()=>iframes,contexts:()=>beacons.contexts});
    const authority={};policy.bind_root(authority,rootContext);policy.attach(authority,port,id);policy.document(id,token,rootContext);
    this.target=new rpc.RPCTarget(port);
    this.target.authorize=(message,source)=>policy.authorize(message,source);
    this.target.authorize_attach=()=>{throw new DOMException('Worker port attachment is unavailable','SecurityError');};
    this.target.onmessage=rpc.message_listener;port.start();
  }
  close(){
    if(this.closed)return;this.closed=true;
    indexed_db.disconnect(this.id);clean_ws_connections(this.id);beacons.retire(this.rootId);
    delete iframes[this.id];delete iframes[this.rootId];this.port.close();
  }
}
