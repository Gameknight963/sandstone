import test from 'node:test';
import assert from 'node:assert/strict';
import {SiteDataStore} from '../src/host/site_data.mjs';
import {CookiePolicyBridge,cookie_policy_handler} from '../src/host/cookie_policy_bridge.mjs';
import {websocket_policy_options} from '../src/host/websocket.mjs';
import {setImmediate} from 'node:timers/promises';

class Storage{
  values=new Map();get length(){return this.values.size;}
  key(index){return [...this.values.keys()][index]??null;}
  getItem(key){return this.values.get(key)??null;}
  setItem(key,value){this.values.set(key,String(value));}
  removeItem(key){this.values.delete(key);}
}
const origin='https://worker.test',url=origin+'/directory/script.js';
const cookie=(store,key)=>store.cookies.serializeSync().cookies.find(cookie=>cookie.key===key);
const apply=(store,value,write,policy={})=>store.setCookie(url,value,true,{...policy,cookieWrite:write});

for(const persistent of [false,true]){
  test('Cookie write tokens reject duplicate and superseded writes with '+(persistent?'persistent':'memory')+' storage',()=>{
    const store=new SiteDataStore(persistent?new Storage():undefined),value='session=first; Max-Age=3600; Path=/';let notifications=0;
    const token=store.prepareCookie(url,value);assert.equal(cookie(store,'session'),undefined);
    store.cookieListeners.add(()=>notifications++);
    apply(store,value,token);const before=cookie(store,'session');
    assert.equal(before.lastAccessed,new Date(token.time).toISOString());assert.equal(notifications,1);
    apply(store,value,token);assert.deepEqual(cookie(store,'session'),before);assert.equal(notifications,1);
    store.setCookie(url,'session=newer; Max-Age=3600; Path=/');apply(store,value,token);
    assert.equal(cookie(store,'session').value,'newer');assert.equal(notifications,2);
  });

  test('Conditional cookies cannot bypass a clear, overwrite fresh cookies or change their prepared target with '+(persistent?'persistent':'memory')+' storage',()=>{
    const store=new SiteDataStore(persistent?new Storage():undefined),value='session=old; Path=/';
    const token=store.prepareCookie(url,value);
    apply(store,'other=forged; Path=/',token);assert.equal(cookie(store,'other'),undefined);
    apply(store,'session=forged; Path=/',token);assert.equal(cookie(store,'session'),undefined);
    store.clear('worker.test',{cookies:true,localStorage:false});store.setCookie(url,'session=fresh; Path=/');
    apply(store,value,token);assert.equal(cookie(store,'session').value,'fresh');
    const removal=store.prepareCookie(url,'session=removed; Max-Age=0; Path=/');
    store.setCookie(url,'session=newer; Path=/');apply(store,'session=removed; Max-Age=0; Path=/',removal);
    assert.equal(cookie(store,'session').value,'newer');
  });
}

test('Prepared cookies retain native domain, default-path, HttpOnly and nameless-cookie validation',()=>{
  const store=new SiteDataStore();
  const value='token; Domain=.WORKER.test; HttpOnly',token=store.prepareCookie(url,value);
  assert.equal(token.key,JSON.stringify(['worker.test','/directory','']));apply(store,value,token);
  assert.equal(store.cookies.getCookieStringSync(url),'token');assert.equal(store.documentCookies(url).cookies.length,0);
  assert.equal(store.prepareCookie(url,'token=bad; Domain=other.test'),null);
  assert.equal(store.prepareCookie(url,'bad=none; SameSite=None'),null);
  assert.equal(store.prepareCookie(url,'x=blocked; SameSite=Strict',true,{crossSite:true}),null);
});

test('A replacement persistent provider applies an uncommitted token and preserves newer writes when replaying an uncertain commit',async()=>{
  const storage=new Storage(),first=new SiteDataStore(storage),second=new SiteDataStore(storage);
  const handleFirst=cookie_policy_handler(first),handleSecond=cookie_policy_handler(second);
  const policy=await handleFirst({op:'capture',context:{}});
  second.clear('unrelated.test',{cookies:true,localStorage:false});
  assert.equal(policy.cookieGeneration,undefined);assert.equal(policy.cookieAuthority,'persistent');
  const value='login=initial; Max-Age=3600; Path=/',token=await handleFirst({op:'prepare',url,value,options:policy});
  await handleSecond({op:'set',url,value,options:{...policy,cookieWrite:token}});
  assert.equal(cookie(second,'login').value,'initial');
  second.setCookie(url,'login=newer; Max-Age=3600; Path=/');
  await handleSecond({op:'set',url,value,options:{...policy,cookieWrite:token}});
  assert.equal(cookie(second,'login').value,'newer');
});

test('A retried session cookie restores a lost provider payload without changing its committed version or timestamp',()=>{
  const storage=new Storage(),first=new SiteDataStore(storage),value='session=secret; HttpOnly; Path=/';
  const token=first.prepareCookie(url,value);apply(first,value,token);
  const before=first.persistence.cookieVersion(token.cookie),replacement=new SiteDataStore(storage);
  assert.equal(cookie(replacement,'session'),undefined,'The lost private payload should not exist in localStorage');
  apply(replacement,value,token);assert.equal(cookie(replacement,'session').value,'secret');
  assert.deepEqual(replacement.persistence.cookieVersion(token.cookie),before);
  assert.equal(cookie(replacement,'session').lastAccessed,token.cookie.lastAccessed);
  assert.equal(replacement.documentCookies(url).cookies.length,0);
  first.setCookie(url,'session=newer; HttpOnly; Path=/');
  const third=new SiteDataStore(storage);apply(third,value,token);assert.equal(cookie(third,'session'),undefined,'An old token restored a superseded private payload');
});

test('The policy bridge retries an uncertain commit with the same prepared token',async()=>{
  const storage=new Storage(),first=new SiteDataStore(storage),second=new SiteDataStore(storage),a=cookie_policy_handler(first),b=cookie_policy_handler(second);
  const bridge=new CookiePolicyBridge(async message=>{
    if(message.op!=='set')return a(message);
    await a(message);second.setCookie(url,'session=newer; Max-Age=3600; Path=/');
    return b(structuredClone(message));
  });
  const policy=await bridge.captureCookieContext({});await bridge.setCookie(url,'session=old; Max-Age=3600; Path=/',true,policy);
  assert.equal(cookie(second,'session').value,'newer');
});

test('A token from an isolated memory authority cannot modify another host cookie jar',async()=>{
  const first=new SiteDataStore(),second=new SiteDataStore(),value='session=secret; Path=/';
  const token=first.prepareCookie(url,value);apply(second,value,token);assert.equal(cookie(second,'session'),undefined);
  const policy=await cookie_policy_handler(first)({op:'capture',context:{}});
  await assert.rejects(cookie_policy_handler(second)({op:'capture',context:policy}),{name:'InvalidStateError'});
  second.setCookie(url,'other_session=private; Path=/');
  await assert.rejects(cookie_policy_handler(second)({op:'header',url,options:{cookieAuthority:policy.cookieAuthority}}),{name:'InvalidStateError'});
});

test('Concurrent response cookies prepare and commit in their accepted order',async()=>{
  const store=new SiteDataStore(),handle=cookie_policy_handler(store),calls=[];
  const bridge=new CookiePolicyBridge(async message=>{calls.push(message.op+':'+message.value);await setImmediate();return handle(message);});
  const policy=await bridge.captureCookieContext({});
  await Promise.all(['first','second','third'].map(value=>bridge.setCookie(url,'session='+value+'; Path=/',true,policy)));
  assert.equal(cookie(store,'session').value,'third');
  assert.deepEqual(calls.filter(value=>!value.startsWith('capture:')),['prepare:session=first; Path=/','set:session=first; Path=/','prepare:session=second; Path=/','set:session=second; Path=/','prepare:session=third; Path=/','set:session=third; Path=/']);
});

test('WebSocket headers reserve cookie writes before a later HTTP response',async()=>{
  const store=new SiteDataStore(),handle=cookie_policy_handler(store);
  const bridge=new CookiePolicyBridge(async message=>{await setImmediate();return handle(message);});
  const options=await websocket_policy_options(bridge,'wss://worker.test/socket',{url});
  options.onHeader('set-cookie','session=socket-first; Path=/');options.onHeader('set-cookie','session=socket-second; Path=/');
  const pending=bridge.setCookie(url,'session=http-last; Path=/',true,await bridge.captureCookieContext({}));
  await Promise.all([options.cookiesReady(),pending]);assert.equal(cookie(store,'session').value,'http-last');
});

test('Aborting a queued cookie write settles immediately and never reaches the provider',async()=>{
  const store=new SiteDataStore(),handle=cookie_policy_handler(store),controller=new AbortController();let release,entered;
  const held=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),calls=[];
  const bridge=new CookiePolicyBridge(async message=>{
    calls.push(message.value);if(message.op==='set'&&message.value.startsWith('first=')){entered();await held;}
    return handle(message);
  });
  const policy=await bridge.captureCookieContext({}),first=bridge.setCookie(url,'first=accepted; Path=/',true,policy);
  await started;const second=bridge.setCookie(url,'second=cancelled; Path=/',true,policy,controller.signal);
  controller.abort();await assert.rejects(second,{name:'AbortError'});release();await first;await bridge.writes;
  assert.equal(cookie(store,'second'),undefined);assert.equal(calls.some(value=>value?.startsWith('second=')),false);
});

test('Prepared payloads and versions observe a peer record before its revision notification',()=>{
  const storage=new Storage(),first=new SiteDataStore(storage);first.setCookie(url,'session=before; Max-Age=3600; Path=/');
  const second=new SiteDataStore(storage);
  const [key,text]=[...storage.values].find(([key])=>key.startsWith('sandstone_site_data_v2:["cookie",'));
  const record=JSON.parse(text),creation=new Date(Date.now()+1000).toISOString();
  record.value.creation=creation;record.value.value='peer';record.version='peer-write';storage.setItem(key,JSON.stringify(record));
  const token=second.prepareCookie(url,'session=next; Max-Age=3600; Path=/');
  assert.equal(token.previous,'peer-write');assert.equal(token.cookie.creation,creation);
  apply(second,'session=next; Max-Age=3600; Path=/',token);
  assert.equal(cookie(second,'session').creation,creation);assert.equal(cookie(second,'session').value,'next');
});

test('Recovering a private session payload retains cookie header order when creation timestamps tie',()=>{
  const storage=new Storage(),first=new SiteDataStore(storage);
  const session='session=first; HttpOnly; Path=/',token=first.prepareCookie(url,session);apply(first,session,token);
  const durable='durable=second; Max-Age=3600; Path=/',next=first.prepareCookie(url,durable);next.time=token.time;apply(first,durable,next);
  const second=new SiteDataStore(storage);apply(second,session,token);
  assert.equal(second.cookies.getCookieStringSync(url),'session=first; durable=second');
});
