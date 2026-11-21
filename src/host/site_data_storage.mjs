const prefix='sandstone_site_data_v2:';
const key=parts=>prefix+JSON.stringify(parts);
const durable=cookie=>(cookie.expires&&cookie.expires!=='Infinity')||typeof cookie.maxAge==='number';
export const cookie_storage_key=cookie=>JSON.stringify([cookie.domain,cookie.path||'/',cookie.key||'']);
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
export const compare_storage_order=(a,b)=>a[0]-b[0]||a[1]-b[1]||String(a[2]).localeCompare(String(b[2]));
// Inputs arrive from the host's authenticated document context. Blank/srcdoc
// documents inherit an origin while retaining their own URL in storage events.
const source=(origin,input)=>{try{const url=new URL(input||origin);if(url.origin===origin||url.protocol==='about:'&&['blank','srcdoc'].includes(url.pathname))return url.href;}catch{}return origin+'/';};
const token=value=>{try{return JSON.parse(value)?.id||value;}catch{return value;}};

// Each cookie and localStorage entry has its own native storage key. An epoch
// advanced by a clear invalidates a write which started before that clear,
// even if its individual setItem arrives afterwards from another host.
export class SiteDataStorage {
  constructor(storage,{epoch=()=>globalThis.crypto?.randomUUID?.()||Date.now()+':'+Math.random()}={}){
    this.storage=storage;this.epoch=epoch;this.actor=epoch();this.sequence=0;
  }
  static supported(storage){return !!storage&&typeof storage.key==='function'&&typeof storage.length==='number';}
  static migrated(storage){return !!storage.getItem(key(['migrated']));}
  entries(){
    const keys=[];
    for(let index=0;index<this.storage.length;index++){
      const name=this.storage.key(index);if(typeof name==='string'&&name.startsWith(prefix))keys.push(name);
    }
    return keys.flatMap(name=>{try{const parts=JSON.parse(name.slice(prefix.length));return Array.isArray(parts)?[[name,parts]]:[];}catch{return [];}});
  }
  read(parts){try{return JSON.parse(this.storage.getItem(key(parts))||'null');}catch{return null;}}
  revision(){return this.storage.getItem(key(['revision']))||'';}
  touch(){this.storage.setItem(key(['revision']),this.epoch());}
  write(parts,value){this.storage.setItem(key(parts),JSON.stringify(value));this.touch();}
  cookieEpoch(domain){return this.storage.getItem(key(['cookie-clear',domain]))||'';}
  localEpoch(origin){return [this.storage.getItem(key(['local-site-clear',new URL(origin).hostname]))||'',token(this.storage.getItem(key(['local-clear',origin]))||'')];}
  order(){return [Date.now(),++this.sequence,this.actor];}
  migrate(saved){
    if(this.storage.getItem(key(['migrated'])))return;
    let sequence=0;
    for(const [origin,entries] of Object.entries(saved?.local||{})){
      try{new URL(origin);}catch{continue;}
      if(!Array.isArray(entries))continue;
      for(const [name,value] of entries){
        const parts=['local',origin,String(name),'',''],order=[0,++sequence,'legacy'];
        if(this.storage.getItem(key(parts))===null)this.write(parts,{epoch:['',''],value:String(value),order});
      }
    }
    for(const cookie of saved?.cookies?.cookies||[]){
      if(!durable(cookie))continue;
      const parts=['cookie',cookie.domain,cookie.path||'/',cookie.key||'',''],order=[0,++sequence,'legacy'];
      // Legacy values always belong to the initial epoch. A migration racing
      // with a clear must never tag old values with that clear's new epoch.
      if(this.storage.getItem(key(parts))===null)this.write(parts,{epoch:'',value:cookie,order});
    }
    if(this.storage.getItem(key(['indexed']))===null)this.write(['indexed'],saved?.indexed||[]);
    this.storage.setItem(key(['migrated']),'1');
    this.storage.removeItem('sandstone_site_data_v1');
    this.storage.removeItem('proxy_local_storage');
  }
  snapshot(){
    const areas=new Map(),cookies=[],epochs=new Map(),cookieOrders=new Map();
    const entries=this.entries();
    for(const [name,parts] of entries)if(parts[0]==='cookie-clear'&&parts.length===2)epochs.set(parts[1],this.storage.getItem(name)||'');
    for(const [name,parts] of entries){
      if(parts[0]!=='cookie'&&parts[0]!=='local')continue;
      const record=this.read(parts);if(!record)continue;
      if(parts[0]==='cookie'&&parts.length===5){
        if(record.epoch!==parts[4]||parts[4]!==(epochs.get(parts[1])||''))continue;
        cookieOrders.set(JSON.stringify(parts.slice(1,4)),record.order||[0,0,name]);
        const value=record.value;
        if(value?.domain===parts[1]&&(value.path||'/')===parts[2]&&(value.key||'')===parts[3])cookies.push(value);
      }else if(parts[0]==='local'&&parts.length===5&&typeof record.value==='string'){
        try{
          if(!same(record.epoch,parts.slice(3))||!same(record.epoch,this.localEpoch(parts[1])))continue;
          if(!areas.has(parts[1]))areas.set(parts[1],[]);
          areas.get(parts[1]).push({key:parts[2],value:record.value,order:record.order||[0,0,name]});
        }catch{}
      }
    }
    const local=Object.create(null);
    const compare=(a,b)=>compare_storage_order(a.order,b.order);
    for(const [origin,entries] of areas)local[origin]=entries.sort(compare).map(entry=>[entry.key,entry.value]);
    const indexed=this.read(['indexed']);
    return {local,cookies,epochs,cookieOrders,indexed:Array.isArray(indexed)?indexed:[]};
  }
  cookieVersion(cookie){
    const epoch=this.cookieEpoch(cookie.domain),record=this.read(['cookie',cookie.domain,cookie.path||'/',cookie.key||'',epoch]);
    return {epoch,version:record?.version||'legacy:'+JSON.stringify(record),order:record?.order};
  }
  setCookie(cookie,version=this.epoch()){
    const epoch=this.cookieEpoch(cookie.domain),parts=['cookie',cookie.domain,cookie.path||'/',cookie.key||'',epoch];
    const previous=this.read(parts),order=previous?.value?.creation===cookie.creation&&previous.order||this.order();
    this.write(parts,{epoch,value:durable(cookie)?cookie:null,order,version});return {epoch,order};
  }
  changeLocal(origin,change){
    if(change.type==='clear'){this.clearLocal(origin,change.url);return;}
    const epoch=this.localEpoch(origin),parts=['local',origin,change.key,...epoch],previous=this.read(parts);
    const existing=previous&&previous.value!==null&&same(previous.epoch,epoch);
    this.write(parts,{epoch,value:change.type==='remove'?null:change.value,order:existing?previous.order:this.order(),url:source(origin,change.url)});
  }
  setLocal(origin,entries){
    const next=new Map(entries),before=this.snapshot().local[origin]||[];
    for(const [name] of before)if(!next.has(name))this.changeLocal(origin,{type:'remove',key:name});
    for(const [name,value] of next)this.changeLocal(origin,{type:'set',key:name,value});
  }
  clearLocal(origin,url){
    const changed=!!this.snapshot().local[origin]?.length;
    const details={id:this.epoch(),url:source(origin,url),changed};
    try{this.storage.setItem(key(['local-clear',origin]),JSON.stringify(details));}
    catch(error){
      if(error.name!=='QuotaExceededError')throw error;
      for(const [name,parts] of this.entries())if(parts[0]==='local'&&parts[1]===origin)this.storage.removeItem(name);
      try{this.storage.setItem(key(['local-clear',origin]),JSON.stringify(details));}
      catch(error){if(error.name!=='QuotaExceededError')throw error;this.storage.setItem(key(['local-clear',origin]),JSON.stringify({id:details.id,changed}));}
    }
    this.touch();
    for(const [name,parts] of this.entries())if(parts[0]==='local'&&parts[1]===origin&&!same(parts.slice(3),this.localEpoch(origin)))this.storage.removeItem(name);
  }
  clearSite(hostname,{cookies,localStorage}){
    const advance=()=>{
      if(cookies)this.storage.setItem(key(['cookie-clear',hostname]),this.epoch());
      if(localStorage)this.storage.setItem(key(['local-site-clear',hostname]),this.epoch());
    };
    try{advance();}
    catch(error){
      if(error.name!=='QuotaExceededError')throw error;
      for(const [name,parts] of this.entries()){
        if(cookies&&parts[0]==='cookie'&&parts[1]===hostname)this.storage.removeItem(name);
        if(localStorage&&parts[0]==='local'&&new URL(parts[1]).hostname===hostname)this.storage.removeItem(name);
      }
      advance();
    }
    this.touch();
    for(const [name,parts] of this.entries()){
      if(cookies&&parts[0]==='cookie'&&parts[1]===hostname&&parts[4]!==this.cookieEpoch(hostname))this.storage.removeItem(name);
      if(localStorage&&parts[0]==='local')try{if(new URL(parts[1]).hostname===hostname&&!same(parts.slice(3),this.localEpoch(parts[1])))this.storage.removeItem(name);}catch{}
    }
  }
  setIndexed(indexed){this.write(['indexed'],indexed);}
  storageEvent(event){
    if(typeof event.key!=='string'||!event.key.startsWith(prefix))return;
    try{
      const parts=JSON.parse(event.key.slice(prefix.length)),before=JSON.parse(event.oldValue||'null'),after=JSON.parse(event.newValue||'null');
      if(parts[0]==='local'&&parts.length===5){
        // Physical removals reclaim old epochs during a clear. The clear's
        // epoch event is the single public event for that operation.
        if(after===null)return;
        const oldValue=typeof before?.value==='string'?before.value:null,newValue=typeof after?.value==='string'?after.value:null;
        if(oldValue===newValue)return;
        return {origin:parts[1],change:{key:parts[2],oldValue,newValue,url:source(parts[1],after?.url||before?.url)}};
      }
      if(parts[0]==='local-clear'&&parts.length===2&&after?.changed)return {origin:parts[1],change:{key:null,oldValue:null,newValue:null,url:source(parts[1],after.url)}};
    }catch{}
  }
}
