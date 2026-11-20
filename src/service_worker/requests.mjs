import {create_bootstrap_nonce} from '../bootstrap.mjs';
const origin_url=value=>{if(value==null)return;const url=new URL(value);return /^https?:$/.test(url.protocol)?url.origin+'/':url.href;};

// Request copies in a worker retain the originating client's policy context.
// The worker receives only an opaque, owner-bound reference, never permission
// to supply an arbitrary Origin, top-level site or ancestor cookie policy.
export class ServiceWorkerRequests{
  constructor({id=create_bootstrap_nonce,limit=4096}={}){Object.assign(this,{id,limit});this.records=new Map();}
  issue(owner,input,context){
    while(this.records.size>=this.limit)this.records.delete(this.records.keys().next().value);
    const token=this.id(),url=new URL(input).href;
    const snapshot=Object.fromEntries(['url','top_url','referrer_url','broadcast_origin','referrerPolicy','metadata_source','cookieGeneration'].map(key=>[key,context[key]]));
    for(const key of ['url','top_url','referrer_url','metadata_source'])snapshot[key]=origin_url(snapshot[key]);
    Object.assign(snapshot,{navigation:!!context.navigation,nested:!!context.nested,cross_site:!!context.cross_site,user_activation:false,history_user_activation:false,request_metadata:undefined});
    this.records.set(token,{owner,url,context:Object.freeze(snapshot)});return token;
  }
  restore(owner,token,input){
    const record=this.records.get(token);
    if(!record||record.owner!==owner||record.url!==new URL(input).href)throw new DOMException('Unknown service worker request context','SecurityError');
    return record.context;
  }
  disconnect(owner){for(const [token,record] of this.records)if(record.owner===owner)this.records.delete(token);}
}
