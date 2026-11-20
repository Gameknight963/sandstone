import test from 'node:test';
import assert from 'node:assert/strict';
import {SiteDataStore} from '../src/host/site_data.mjs';
import {fetch_with_cookies} from '../src/host/request.mjs';
import {websocket_options} from '../src/host/websocket.mjs';

const origin='https://cookies.test';
function deferred(){let resolve;const promise=new Promise(value=>resolve=value);return {promise,resolve};}
const response=cookies=>new Response('body',{headers:cookies.map(value=>['set-cookie',value])});
test('Clearing cookies rejects late response writes and deletions without overwriting fresh cookies',async()=>{
  const store=new SiteDataStore(),held=deferred();store.setCookie(origin,'old=before; Path=/');
  const pending=fetch_with_cookies(()=>held.promise,store,origin+'/held',{credentials:'include'},{url:origin+'/page'});
  store.clear('cookies.test',{cookies:true,localStorage:false});store.setCookie(origin,'fresh=after; Path=/');
  held.resolve(response(['old=restored; Path=/; HttpOnly','fresh=deleted; Max-Age=0; Path=/']));assert.equal(await(await pending).text(),'body');
  assert.equal(store.cookies.getCookieStringSync(origin),'fresh=after');
});
test('Cookie clear barriers use cookie domains rather than response hosts and preserve unrelated writes',async()=>{
  const store=new SiteDataStore(),held=deferred(),url='https://child.cookies.test/held';
  const pending=fetch_with_cookies(()=>held.promise,store,url,{credentials:'include'},{url});
  store.clear('cookies.test',{cookies:true,localStorage:false});
  held.resolve(response(['parent=old; Domain=.COOKIES.test; Path=/','child=allowed; Path=/']));await(await pending).text();
  assert.equal(store.cookies.getCookieStringSync(url),'child=allowed');assert.equal(store.cookies.getCookieStringSync(origin),'');
  const another=deferred(),next=fetch_with_cookies(()=>another.promise,store,origin+'/held',{}, {url:origin});store.clear('unrelated.test',{cookies:true,localStorage:false});another.resolve(response(['accepted=yes; Path=/']));await(await next).text();assert.equal(store.cookies.getCookieStringSync(origin),'accepted=yes');
});
test('A logical redirect chain retains its cookie clear barrier across later hops',async()=>{
  const store=new SiteDataStore(),held=deferred(),started=deferred();let calls=0;
  const pending=fetch_with_cookies(async()=>{if(++calls===1)return new Response(null,{status:302,headers:{location:'/next','set-cookie':'before=old; Path=/'}});started.resolve();return held.promise;},store,origin+'/start',{}, {url:origin});
  await started.promise;store.clear('cookies.test',{cookies:true,localStorage:false});held.resolve(response(['late=old; Path=/']));await(await pending).text();assert.equal(store.cookies.getCookieStringSync(origin),'');
  await(await fetch_with_cookies(async()=>response(['new=fresh; Path=/']),store,origin+'/fresh',{}, {url:origin})).text();assert.equal(store.cookies.getCookieStringSync(origin),'new=fresh');
});
test('Clearing local storage leaves pending cookie responses valid',async()=>{
  const store=new SiteDataStore(),held=deferred(),pending=fetch_with_cookies(()=>held.promise,store,origin+'/held',{}, {url:origin});
  store.clear('cookies.test',{cookies:false,localStorage:true});held.resolve(response(['accepted=yes; Path=/']));await(await pending).text();assert.equal(store.cookies.getCookieStringSync(origin),'accepted=yes');
});
test('Pending WebSocket handshake cookies cannot resurrect cleared values or delete fresh ones',()=>{
  const store=new SiteDataStore(),old=websocket_options(store,'wss://cookies.test/socket',{url:origin});
  store.clear('cookies.test',{cookies:true,localStorage:false});const fresh=websocket_options(store,'wss://cookies.test/socket',{url:origin});fresh.onHeader('set-cookie','new=fresh; Path=/');
  old.onHeader('set-cookie','old=restored; HttpOnly; Path=/');old.onHeader('set-cookie','new=deleted; Max-Age=0; Path=/');assert.equal(store.cookies.getCookieStringSync(origin),'new=fresh');
});

test('Rejected old cookie responses cannot resurrect persisted cookies on reload',async()=>{
  const values=new Map(),storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)},store=new SiteDataStore(storage),held=deferred();
  store.setCookie(origin,'old=before; Path=/; Max-Age=3600');const pending=fetch_with_cookies(()=>held.promise,store,origin+'/held',{}, {url:origin});
  store.clear('cookies.test',{cookies:true,localStorage:false});store.setCookie(origin,'new=after; Path=/; Max-Age=3600');held.resolve(response(['old=restored; Path=/; Max-Age=3600']));await(await pending).text();
  assert.equal(new SiteDataStore(storage).cookies.getCookieStringSync(origin),'new=after');
});

test('Cookie clear barriers match canonical host-only domains for IP and internationalized hosts',async()=>{
  for(const url of ['https://127.0.0.1/','https://[::1]/','https://b\u00fccher.test/']){
    const store=new SiteDataStore(),held=deferred(),cookie=store.setCookie(url,'old=before; Path=/');assert.ok(cookie,url);
    const pending=fetch_with_cookies(()=>held.promise,store,url,{}, {url});store.clear(cookie.domain,{cookies:true,localStorage:false});held.resolve(response(['old=restored; Path=/']));await(await pending).text();
    assert.equal(store.cookies.getCookieStringSync(url),'',url);
  }
});
