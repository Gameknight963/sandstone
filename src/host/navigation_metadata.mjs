import {create_bootstrap_nonce} from '../bootstrap.mjs';

// A child passes an opaque receipt back during registration. The receipt
// binds the host-computed metadata to that frame, URL and parent document;
// history never accepts a site's claimed origin or activation flags.
export class NavigationMetadata {
  constructor(owner,{nonce=create_bootstrap_nonce,now=Date.now,limit=1024,ttl=120000}={}){
    this.owner=owner;this.nonce=nonce;this.now=now;this.limit=limit;this.ttl=ttl;this.records=new Map();
  }
  capture(parent,child){
    const owner=this.owner(parent);
    return owner?Object.freeze({parent,child,owner}):undefined;
  }
  issue(scope,url,metadata,attachment){
    if(!scope||!metadata)return;
    const {parent,child,owner}=scope;
    if(this.owner(parent)!==owner)return;
    const now=this.now();
    for(const [token,record] of this.records)if(record.expires<=now||this.owner(record.parent)!==record.owner){this.records.delete(token);record.attachment?.release();}
    while(this.records.size>=this.limit){const token=this.records.keys().next().value;this.records.get(token).attachment?.release();this.records.delete(token);}
    const token=this.nonce();
    this.records.set(token,{parent,child,url:new URL(url).href,owner,metadata:Object.freeze({...metadata}),attachment,expires:now+this.ttl});
    return token;
  }
  claim(token,parent,child,url){
    return this.take(token,parent,child,url)?.metadata;
  }
  take(token,parent,child,url){
    const record=this.records.get(token);if(!record)return;
    if(record.expires<=this.now()||this.owner(record.parent)!==record.owner){this.records.delete(token);record.attachment?.release();return;}
    if(record.parent!==parent||record.child!==child||record.url!==new URL(url).href)return;
    this.records.delete(token);return record;
  }
}
