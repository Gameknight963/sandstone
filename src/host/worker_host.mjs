import {iframes} from './frames.mjs';
import {beacons,clean_ws_connections,fetch as fetch_worker} from './network.mjs';
import {indexed_db} from './indexeddb.mjs';
import {crypto_service} from './crypto.mjs';
import {WorkerRPCPolicy} from './worker_policy.mjs';
import {create_bootstrap_nonce} from '../bootstrap.mjs';
import * as rpc from '../rpc.mjs';
import {worker_urls} from './worker_urls.mjs';
import {document_request_url} from './document_url.mjs';
import {prepare_worker_scripts} from './worker_scripts.mjs';

// Trusted hosts may retain a worker independently of any renderer document.
// Only its bound port can address this context; document/navigation procedures
// and further port attachment are unavailable to the remote worker.
export class WorkerServiceHost {
  #source;
  #creator;
  #frame;
  #preparation;
  #controller=new AbortController();
  constructor({url,creator_url,top_url,cross_site=false,referrer_policy,cookie_policy,cookie_authority}={},port){
    const {script,creator,top,origin}=worker_urls({url,creator_url,top_url});
    if(!(port instanceof MessagePort))throw new TypeError('A worker MessagePort is required');
    if(cookie_policy&&['captureCookieContext','cookieHeader','setCookie'].some(name=>typeof cookie_policy[name]!=='function'))throw new TypeError('Invalid worker cookie policy');
    if(cookie_authority!==undefined&&(typeof cookie_authority!=='string'||!cookie_authority))throw new TypeError('Invalid worker cookie authority');
    const rootId='worker-owner:'+create_bootstrap_nonce(),id='worker:'+create_bootstrap_nonce();
    const rootContext=beacons.register(rootId,{url:top.href,top_url:top.href,root_id:rootId,broadcast_origin:top.origin});
    const broadcast_origin=origin==='null'?'opaque:'+id:origin,referrer_url=script.protocol==='blob:'?script.href:undefined;
    const request_url=script.protocol==='blob:'?origin+'/':undefined;
    const frame={id,root_id:rootId,parent_id:rootId,parent_context:rootContext,worker:true,url:script,origin,broadcast_origin,request_url,referrer_url,retained_cross_site:!!cross_site,cookie_policy,cookie_authority};
    const token=beacons.register(id,{url:document_request_url(frame),referrer_url,top_url:top.href,root_id:rootId,frame_id:id,broadcast_origin,cross_site:!!cross_site,referrerPolicy:referrer_policy,cookieAuthority:cookie_authority});
    frame.document_context=token;
    this.id=id;this.rootId=rootId;this.port=port;
    this.profile={url:script.href,origin,frame_id:id,beacon_context:token,referrer_policy,crypto_available:crypto_service.methods};
    this.#frame=frame;this.#source=Object.freeze({url:script.href,creator_url:creator.href,top_url:top.href,referrer_policy});
    this.#creator=Object.freeze({...beacons.contexts.get(token).context,url:creator.href,broadcast_origin:creator.origin});
    const root={id:rootId,root_id:rootId,url:top,origin:top.origin,document_context:rootContext,
      // The metadata owner is not a document. In particular it must never
      // receive top-level cookies on the remote worker's port.
      rpc_target:{target:null,extra_frame_targets:new Map([[id,port]])}};
    iframes[rootId]=root;iframes[id]=frame;
    const policy=new WorkerRPCPolicy({root:rootId,frames:()=>iframes,contexts:()=>beacons.contexts});
    const authority={};policy.bind_root(authority,rootContext);policy.attach(authority,port,id);policy.document(id,token,rootContext);
    this.target=new rpc.RPCTarget(port);
    this.target.authorize=(message,source)=>policy.authorize(message,source);
    this.target.authorize_attach=()=>{throw new DOMException('Worker port attachment is unavailable','SecurityError');};
    this.target.onmessage=rpc.message_listener;port.start();
  }
  prepare(input={}){
    if(this.closed)return Promise.reject(new DOMException('Worker service is closed','AbortError'));
    if(this.#preparation)return this.#preparation;
    const signal=this.#controller.signal;
    this.#preparation=prepare_worker_scripts({...this.#source,options:input.options,destination:input.destination,local_source:input.local_source,local_sources:input.local_sources},{signal,fetch:(url,options,phase)=>{
      const context=phase.entry?this.#creator:{...beacons.contexts.get(this.profile.beacon_context).context,url:new URL(phase.url).protocol==='blob:'?this.profile.origin+'/':phase.url};
      return fetch_worker(url,options,context);
    }}).then(scripts=>{
      signal.throwIfAborted();
      const frame=this.#frame,context=beacons.contexts.get(this.profile.beacon_context).context;
      frame.url=new URL(scripts.url);Object.assign(this.profile,{url:scripts.url,referrer_policy:scripts.referrer_policy});
      context.url=document_request_url(frame);context.referrerPolicy=scripts.referrer_policy;
      return scripts;
    });
    return this.#preparation;
  }
  close(){
    if(this.closed)return;this.closed=true;this.#controller.abort();
    indexed_db.disconnect(this.id);clean_ws_connections(this.id);beacons.retire(this.rootId);
    delete iframes[this.id];delete iframes[this.rootId];this.port.close();
  }
}
