import test from 'node:test';
import assert from 'node:assert/strict';
import {SiteDataStore} from '../src/host/site_data.mjs';
import {cookie_header} from '../src/host/cookie_policy.mjs';
import {CookieReplica} from '../src/cookie_replica.mjs';
import {CookieJar} from 'tough-cookie';

const url='https://cookie-expiry.test/path/page';
class Storage{
  values=new Map();get length(){return this.values.size;}
  key(index){return [...this.values.keys()][index]??null;}
  getItem(key){return this.values.get(key)??null;}
  setItem(key,value){this.values.set(key,String(value));}
  removeItem(key){this.values.delete(key);}
}

test('Reading request cookies does not renew their Max-Age deadline',context=>{
  context.mock.timers.enable({apis:['Date'],now:1700000000000});
  const store=new SiteDataStore();store.setCookie(url,'short=1; Max-Age=1; Path=/');
  for(let elapsed=200;elapsed<=1200;elapsed+=200){
    context.mock.timers.tick(200);
    assert.equal(cookie_header(store.cookies,url),elapsed<1000?'short=1':'','Cookie deadline changed at '+elapsed+'ms');
  }
});

test('Reading optimistic document cookies cannot keep them alive while their acknowledgement is pending',context=>{
  context.mock.timers.enable({apis:['Date'],now:1700000000000});
  const replica=new CookieReplica({submit:()=>new Promise(()=>{})});replica.write('short=1; Max-Age=1; Path=/',url);
  for(let elapsed=200;elapsed<=1200;elapsed+=200){
    context.mock.timers.tick(200);
    assert.equal(replica.read(url),elapsed<1000?'short=1':'','Document cookie deadline changed at '+elapsed+'ms');
  }
});

test('Replacing an expired cookie creates a fresh cookie, including after an expired HttpOnly value',context=>{
  context.mock.timers.enable({apis:['Date'],now:1700000000000});
  const store=new SiteDataStore();store.setCookie(url,'old=private; HttpOnly; Max-Age=1; Path=/');
  context.mock.timers.tick(180000);
  store.setCookie(url,'old=public; Max-Age=3600; Path=/',false);
  assert.equal(cookie_header(store.cookies,url,{sameSiteContext:'none',allowUnsafe:true}),'old=public');
});

test('An actual write renews the deadline while preserving an unexpired cookie creation time',context=>{
  context.mock.timers.enable({apis:['Date'],now:1700000000000});
  const store=new SiteDataStore();store.setCookie(url,'short=1; Max-Age=1; Path=/');
  const created=store.cookies.serializeSync().cookies[0].creation;
  context.mock.timers.tick(600);store.setCookie(url,'short=2; Max-Age=1; Path=/');
  assert.equal(store.cookies.serializeSync().cookies[0].creation,created);
  context.mock.timers.tick(600);assert.equal(cookie_header(store.cookies,url),'short=2');
  context.mock.timers.tick(400);assert.equal(cookie_header(store.cookies,url),'');
});

test('Max-Age takes precedence over Expires for both expiry and deletion',context=>{
  context.mock.timers.enable({apis:['Date'],now:1700000000000});
  const store=new SiteDataStore();
  store.setCookie(url,'valid=1; Max-Age=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/');
  store.setCookie(url,'deleted=1; Max-Age=0; Expires=Thu, 01 Jan 2099 00:00:00 GMT; Path=/');
  assert.equal(cookie_header(store.cookies,url),'valid=1');context.mock.timers.tick(1000);assert.equal(cookie_header(store.cookies,url),'');
});

test('Legacy host and frame snapshots retain their original Max-Age reference when loaded later',context=>{
  context.mock.timers.enable({apis:['Date'],now:1700000000000});
  const jar=new CookieJar();jar.setCookieSync('legacy=1; Max-Age=1; Path=/',url);const snapshot=jar.serializeSync();
  context.mock.timers.tick(600);
  const storage={getItem:key=>key==='sandstone_site_data_v1'?JSON.stringify({cookies:snapshot}):null,setItem(){}};
  const store=new SiteDataStore(storage),replica=new CookieReplica();replica.reset(snapshot);
  for(let elapsed=600;elapsed<=1200;elapsed+=200){
    assert.equal(cookie_header(store.cookies,url),elapsed<1000?'legacy=1':'');assert.equal(replica.read(url),elapsed<1000?'legacy=1':'');context.mock.timers.tick(200);
  }
  assert.equal(snapshot.cookies[0].maxAge,1,'Normalizing a received snapshot mutated its owner');
});

test('Prepared and retried response cookies do not receive a fresh deadline after policy delays',context=>{
  context.mock.timers.enable({apis:['Date'],now:1700000000000});
  const store=new SiteDataStore(),value='short=1; Max-Age=1; Path=/',token=store.prepareCookie(url,value);
  context.mock.timers.tick(600);store.setCookie(url,value,true,{cookieWrite:token});assert.equal(cookie_header(store.cookies,url),'short=1');
  context.mock.timers.tick(600);assert.equal(cookie_header(store.cookies,url),'');
  store.setCookie(url,value,true,{cookieWrite:token});assert.equal(cookie_header(store.cookies,url),'');
});

test('Very large Max-Age values remain usable without overflowing Date serialization',()=>{
  const replica=new CookieReplica({submit:()=>new Promise(()=>{})});
  replica.write('long=1; Max-Age=999999999999999999999999999999999; Path=/',url);
  assert.equal(replica.read(url),'long=1');assert.equal(new Date(replica.pending[0].cookie.expires).getTime(),8640000000000000);
});

test('Older per-cookie records keep their deadline across reloads without spurious change notifications',context=>{
  context.mock.timers.enable({apis:['Date'],now:1700000000000});
  const storage=new Storage(),store=new SiteDataStore(storage),legacy=new CookieJar();
  legacy.setCookieSync('legacy=1; Max-Age=1; Path=/',url);store.persistence.setCookie(legacy.serializeSync().cookies[0]);store.refresh();
  let changes=0;store.cookieListeners.add(()=>changes++);
  context.mock.timers.tick(600);assert.equal(cookie_header(store.cookies,url),'legacy=1');
  store.changeLocal('https://unrelated.test',{type:'set',key:'value',value:'changed'});store.refresh();
  assert.equal(changes,0);
  const restored=new SiteDataStore(storage);context.mock.timers.tick(400);assert.equal(cookie_header(restored.cookies,url),'');
});
