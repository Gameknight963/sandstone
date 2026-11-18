import {Cookie,CookieJar} from 'tough-cookie';
import {storage_cookie} from './cookie.mjs';

// Keep script writes optimistic until their host replies. A delayed fetch or a
// second frame's older snapshot must not erase a newer document.cookie write.
export class CookieReplica{
  constructor({submit=()=>Promise.resolve()}={}){
    this.submit=submit;this.confirmed=new CookieJar().serializeSync();this.jar=new CookieJar();
    this.pending=[];this.sequence=0;this.revision=-1;
  }
  reset(snapshot,ack){
    let changed=false;
    if(snapshot&&(snapshot.sandstone_revision===undefined||snapshot.sandstone_revision>this.revision)){
      this.confirmed=snapshot;this.revision=snapshot.sandstone_revision??this.revision;
      changed=true;
    }
    if(ack!==undefined){const count=this.pending.length;this.pending=this.pending.filter(write=>write.id!==ack);changed||=count!==this.pending.length;}
    if(changed)this.refresh();
  }
  refresh(){
    this.jar=CookieJar.deserializeSync(this.confirmed);
    for(const write of this.pending)this.jar.setCookieSync(Cookie.fromJSON(write.cookie),write.url,{http:false,ignoreError:true});
  }
  write(text,url,policy){
    const parsed=storage_cookie(text,policy);if(!parsed)return;
    const cookie=this.jar.setCookieSync(parsed,url,{http:false,ignoreError:true});if(!cookie)return;
    const saved=cookie.toJSON();
    if(typeof cookie.maxAge==='number'){
      saved.expires=new Date(cookie.maxAge<=0?0:Date.now()+cookie.maxAge*1000).toISOString();delete saved.maxAge;
    }
    const write={id:++this.sequence,cookie:saved,url};this.pending.push(write);
    Promise.resolve(this.submit(text,url)).then(snapshot=>this.reset(snapshot,write.id),()=>{
      this.reset(undefined,write.id);
    });
  }
  read(url){return this.jar.getCookieStringSync(url,{http:false});}
  // Inherited blank documents join this same replica. Do not accidentally
  // promote its unacknowledged script writes into an authoritative snapshot.
  snapshot(){return {...this.confirmed,sandstone_revision:this.revision};}
}
