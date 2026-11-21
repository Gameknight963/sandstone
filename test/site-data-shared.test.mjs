import test from 'node:test';
import assert from 'node:assert/strict';
import {SiteDataStore} from '../src/host/site_data.mjs';
import {SiteDataStorage} from '../src/host/site_data_storage.mjs';
import {snapshot_request_context} from '../src/host/request.mjs';

class Storage {
  values=new Map();
  get length(){return this.values.size;}
  key(index){return [...this.values.keys()][index]??null;}
  getItem(key){return this.values.get(key)??null;}
  events=[];
  setItem(key,value){
    this.beforeWrite?.(key,value);const oldValue=this.getItem(key);
    const size=[...this.values].reduce((total,[name,text])=>total+name.length+text.length,0)-(oldValue===null?0:key.length+oldValue.length)+key.length+String(value).length;
    if(size>(this.limit??Infinity))throw new DOMException('Full','QuotaExceededError');
    this.values.set(key,String(value));this.events.push({key,oldValue,newValue:String(value)});
  }
  removeItem(key){this.beforeRemove?.(key);const oldValue=this.getItem(key);this.values.delete(key);this.events.push({key,oldValue,newValue:null});}
}
const cookie=(store,url)=>store.documentCookies(url).cookies.map(value=>value.key+'='+value.value).sort();
const account='https://accounts.test/',editor='https://editor.test';

test('Independent hosts preserve cookies and localStorage written by their peers',()=>{
  const storage=new Storage(),first=new SiteDataStore(storage),second=new SiteDataStore(storage);
  first.setCookie(account,'login=first; Max-Age=86400; Path=/');
  second.setLocal(editor,[['document','saved']]);
  assert.deepEqual(cookie(new SiteDataStore(storage),account),['login=first']);
  first.changeLocal(editor,{type:'set',key:'first',value:'one'});
  second.changeLocal(editor,{type:'set',key:'second',value:'two'});
  first.refresh();
  assert.deepEqual(new Map(first.local[editor]),new Map([['document','saved'],['first','one'],['second','two']]));
});

test('Clearing cookies invalidates stale hosts, their session cookies and old response generations',()=>{
  const storage=new Storage(),first=new SiteDataStore(storage),second=new SiteDataStore(storage);
  first.setCookie(account,'login=first; Max-Age=86400; Path=/');
  second.setCookie(account,'session=private; Path=/');
  second.documentCookies(account);const generation=second.cookieGeneration;
  first.clear('accounts.test',{cookies:true,localStorage:false});
  second.setLocal(editor,[['document','changed']]);
  assert.deepEqual(cookie(second,account),[]);
  assert.equal(second.setCookie(account,'login=late; Max-Age=86400; Path=/',true,{cookieGeneration:generation}),undefined);
  assert.deepEqual(cookie(new SiteDataStore(storage),account),[]);
  second.setCookie(account,'login=fresh; Max-Age=86400; Path=/',true,{cookieGeneration:second.cookieGeneration});
  assert.deepEqual(cookie(new SiteDataStore(storage),account),['login=fresh']);
});

test('A clear racing a native write cannot resurrect either stored cookies or localStorage',()=>{
  const storage=new Storage(),first=new SiteDataStore(storage),second=new SiteDataStore(storage);
  for(const kind of ['cookie','local']){
    let raced=false;
    storage.beforeWrite=name=>{
      if(raced||!name.startsWith('sandstone_site_data_v2:["'+kind+'"'))return;
      raced=true;first.clear('accounts.test');
    };
    if(kind==='cookie')second.setCookie(account,'login=late; Max-Age=86400; Path=/');
    else second.changeLocal('https://accounts.test',{type:'set',key:'late',value:'old'});
    storage.beforeWrite=undefined;
    assert.equal(raced,true);
    const reloaded=new SiteDataStore(storage);
    assert.deepEqual(cookie(reloaded,account),[]);
    assert.deepEqual(reloaded.local['https://accounts.test']||[],[]);
  }
});

test('Interleaved hosts write separate keys without overwriting each other',()=>{
  const storage=new Storage(),first=new SiteDataStore(storage),second=new SiteDataStore(storage);
  let raced=false;
  storage.beforeWrite=name=>{
    if(raced||!name.startsWith('sandstone_site_data_v2:["local"'))return;
    raced=true;second.changeLocal(editor,{type:'set',key:'second',value:'two'});
  };
  first.changeLocal(editor,{type:'set',key:'first',value:'one'});storage.beforeWrite=undefined;
  assert.deepEqual(new Map(new SiteDataStore(storage).local[editor]),new Map([['first','one'],['second','two']]));
});

test('Legacy snapshots migrate once and cannot bypass clear epochs even if migration overlaps clearing',()=>{
  const storage=new Storage();
  const legacyStore=new SiteDataStore({getItem:()=>null,setItem(){},removeItem(){}});
  legacyStore.setCookie(account,'login=legacy; Max-Age=86400; Path=/');
  const legacy={local:{'https://accounts.test':[['saved','legacy']]},cookies:legacyStore.cookies.serializeSync(),indexed:[]};
  storage.setItem('sandstone_site_data_v1',JSON.stringify(legacy));
  const migrated=new SiteDataStore(storage);
  assert.deepEqual(cookie(migrated,account),['login=legacy']);
  assert.deepEqual(migrated.local['https://accounts.test'],[['saved','legacy']]);
  migrated.clear('accounts.test');
  storage.removeItem('sandstone_site_data_v2:["migrated"]');
  new SiteDataStorage(storage).migrate(legacy);
  const reloaded=new SiteDataStore(storage);
  assert.deepEqual(cookie(reloaded,account),[]);
  assert.deepEqual(reloaded.local['https://accounts.test']||[],[]);
});

test('Clear cleanup preserves new writes which use the new epoch',()=>{
  const storage=new Storage(),first=new SiteDataStore(storage),second=new SiteDataStore(storage);
  first.setCookie(account,'login=old; Max-Age=86400; Path=/');
  first.setLocal('https://accounts.test',[['old','before']]);
  let changed=false;
  storage.beforeRemove=name=>{
    if(changed||!name.startsWith('sandstone_site_data_v2:["cookie"'))return;
    changed=true;
    second.setCookie(account,'login=new; Max-Age=86400; Path=/');
    second.changeLocal('https://accounts.test',{type:'set',key:'fresh',value:'after'});
  };
  first.clear('accounts.test');storage.beforeRemove=undefined;
  const reloaded=new SiteDataStore(storage);
  assert.equal(changed,true);assert.deepEqual(cookie(reloaded,account),['login=new']);
  assert.deepEqual(reloaded.local['https://accounts.test'],[['fresh','after']]);
});

test('Native storage records retain virtual event URLs and clear emits one public event',()=>{
  const storage=new Storage(),store=new SiteDataStore(storage),persistence=new SiteDataStorage(storage);
  store.changeLocal(editor,{type:'set',key:'first',value:'one',url:editor+'/page'});
  const changes=storage.events.map(event=>persistence.storageEvent(event)).filter(Boolean);
  assert.deepEqual(changes,[{origin:editor,change:{key:'first',oldValue:null,newValue:'one',url:editor+'/page'}}]);
  storage.events=[];store.changeLocal(editor,{type:'clear',url:editor+'/clear'});
  assert.deepEqual(storage.events.map(event=>persistence.storageEvent(event)).filter(Boolean),[{origin:editor,change:{key:null,oldValue:null,newValue:null,url:editor+'/clear'}}]);
});

test('Inherited-origin storage writers retain blank and srcdoc URLs in peer events',()=>{
  for(const url of ['about:blank','about:srcdoc']){
    const storage=new Storage(),store=new SiteDataStore(storage),persistence=new SiteDataStorage(storage);
    for(const change of [{type:'set',key:'child',value:'saved'},{type:'clear'}]){
      storage.events=[];store.changeLocal(editor,{...change,url});
      const events=storage.events.map(event=>persistence.storageEvent(event)).filter(Boolean);
      assert.equal(events.length,1);assert.equal(events[0].origin,editor);assert.equal(events[0].change.url,url);
    }
  }
});

test('Cookie creation order survives native storage enumeration in a different order',()=>{
  const storage=new Storage(),store=new SiteDataStore(storage),creation=new Date().toISOString();
  const common={key:'token',path:'/',maxAge:86400,creation,lastAccessed:creation};
  store.persistence.setCookie({...common,domain:'example.test',hostOnly:false,value:'parent'});
  store.persistence.setCookie({...common,domain:'app.example.test',hostOnly:true,value:'child'});
  storage.values=new Map([...storage.values].reverse());
  assert.equal(new SiteDataStore(storage).cookies.getCookieStringSync('https://app.example.test/'),'token=parent; token=child');
});

test('Nameless and empty cookies retain their native cookie identities after reload',()=>{
  const storage=new Storage(),store=new SiteDataStore(storage);
  store.setCookie(account,'value; Max-Age=86400; Path=/');
  store.setCookie(account,'empty=; Max-Age=86400; Path=/');
  assert.equal(new SiteDataStore(storage).cookies.getCookieStringSync(account),'value; empty=');
});

test('Quota failure during migration retains the complete legacy data as a usable memory session',()=>{
  const storage=new Storage(),origin='https://accounts.test';
  storage.setItem('sandstone_site_data_v1',JSON.stringify({local:{[origin]:[['first','one'],['second','two']]}}));
  let copies=0;
  storage.beforeWrite=name=>{if(name.startsWith('sandstone_site_data_v2:["local"')&&++copies===2)throw new DOMException('Full','QuotaExceededError');};
  const store=new SiteDataStore(storage);store.refresh();
  assert.equal(store.persistent,false);
  assert.deepEqual(store.local[origin],[['first','one'],['second','two']]);
  store.changeLocal(origin,{type:'set',key:'third',value:'memory'});store.refresh();
  assert.deepEqual(store.local[origin],[['first','one'],['second','two'],['third','memory']]);
  storage.beforeWrite=undefined;
  assert.deepEqual(new SiteDataStore(storage).local[origin],[['first','one'],['second','two']]);
  store.clear('accounts.test');
  assert.deepEqual(new SiteDataStore(storage).local[origin]||[],[]);
});

test('Full native storage still permits clearing and reclaiming the selected site',()=>{
  const storage=new Storage(),store=new SiteDataStore(storage),origin='https://accounts.test';
  store.setCookie(account,'login=old; Max-Age=86400; Path=/');store.setLocal(origin,[['saved','old']]);
  storage.limit=[...storage.values].reduce((total,[key,value])=>total+key.length+value.length,0);
  store.clear('accounts.test');
  const reloaded=new SiteDataStore(storage);
  assert.equal(store.persistent,true);assert.equal(reloaded.persistent,true);
  assert.deepEqual(cookie(reloaded,account),[]);assert.deepEqual(reloaded.local[origin]||[],[]);
});

test('Raw cookie-clear epochs reject old responses even before a revision notification arrives',()=>{
  const storage=new Storage(),store=new SiteDataStore(storage);
  store.setCookie(account,'login=before; Max-Age=86400; Path=/');
  const context=snapshot_request_context(store);
  storage.setItem('sandstone_site_data_v2:["cookie-clear","accounts.test"]','foreign-clear');
  assert.equal(store.setCookie(account,'login=late; Max-Age=86400; Path=/',true,context),undefined);
  assert.deepEqual(cookie(new SiteDataStore(storage),account),[]);
});
