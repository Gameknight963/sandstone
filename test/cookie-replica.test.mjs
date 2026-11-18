import test from 'node:test';
import assert from 'node:assert/strict';
import {CookieJar} from 'tough-cookie';
import {CookieReplica} from '../src/cookie_replica.mjs';
import {SiteDataStore} from '../src/host/site_data.mjs';

const url='https://cookie.test/path/page';
function snapshot(revision,...cookies){
  const jar=new CookieJar();for(const cookie of cookies)jar.setCookieSync(cookie,url);
  return {...jar.serializeSync(),sandstone_revision:revision};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('Cookie replicas retain newer pending writes across delayed fetch snapshots and older acknowledgements',async()=>{
  const replies=[];
  const replica=new CookieReplica({submit:()=>new Promise(resolve=>replies.push(resolve))});
  replica.reset(snapshot(0));replica.write('key=first; Path=/',url);replica.write('key=second; Path=/',url);
  replica.reset(snapshot(0));assert.equal(replica.read(url),'key=second');
  replies[0](snapshot(1,'key=first; Path=/'));await tick();assert.equal(replica.read(url),'key=second');
  replica.reset(snapshot(0));assert.equal(replica.read(url),'key=second');
  replies[1](snapshot(2,'key=second; Path=/'));await tick();assert.equal(replica.pending.length,0);
  replica.reset(snapshot(1,'key=first; Path=/'));assert.equal(replica.read(url),'key=second');
});

test('Inherited snapshots never confirm a rejected optimistic write and later acknowledgements cannot resurrect cleared cookies',async()=>{
  let reply;const replica=new CookieReplica({submit:()=>new Promise(resolve=>reply=resolve)});
  replica.reset(snapshot(0));replica.write('key=optimistic; Path=/',url);
  replica.reset(replica.snapshot());assert.equal(replica.read(url),'key=optimistic');
  reply(snapshot(0));await tick();assert.equal(replica.read(url),'');
  replica.write('key=accepted; Path=/',url);replica.reset(snapshot(2));
  reply(snapshot(1,'key=accepted; Path=/'));await tick();assert.equal(replica.read(url),'');
});

test('Cookie replicas enforce domains, paths and script attributes while keeping pending deletions expired',async()=>{
  const replies=[],replica=new CookieReplica({submit:()=>new Promise(resolve=>replies.push(resolve))});
  replica.reset(snapshot(0,'key=old; Path=/'));
  for(const cookie of ['wrong=value; Domain=other.test','private=hidden; HttpOnly','none=bad; SameSite=None','cross=blocked; SameSite=Lax'])replica.write(cookie,url,{crossSite:cookie.startsWith('cross=')});
  assert.equal(replies.length,0);assert.equal(replica.read(url),'key=old');
  replica.write('scoped=inside; Path=/path/',url);assert.match(replica.read(url),/scoped=inside/);
  assert.equal(replica.read('https://cookie.test/other'),'key=old');
  replica.write('key=; Max-Age=0; Path=/',url);replica.reset(snapshot(0,'key=old; Path=/'));
  assert.doesNotMatch(replica.read(url),/(?:^|; )key=/);
  assert.equal(replica.pending.at(-1).cookie.maxAge,undefined);assert.equal(new Date(replica.pending.at(-1).cookie.expires).getTime(),0);
  replies[0](snapshot(1,'key=old; Path=/','scoped=inside; Path=/path/'));replies[1](snapshot(2,'scoped=inside; Path=/path/'));await tick();
  assert.equal(replica.pending.length,0);assert.equal(replica.read(url),'scoped=inside');
});

test('Host cookie revisions notify script, HTTP and clearing changes without putting HttpOnly values in document snapshots',()=>{
  const data=new SiteDataStore(),changes=[];data.cookieListeners.add(domain=>changes.push(domain));
  data.setCookie(url,'script=visible; Path=/',false);const revision=data.documentCookies(url).sandstone_revision;
  data.setCookie(url,'private=secret; HttpOnly; Path=/',true);
  data.setCookie('https://unrelated.test/','other=value; Path=/',true);
  data.cookies.getCookiesSync(url).find(cookie=>cookie.key==='script').lastAccessed=new Date(Date.now()+5000);
  data.setCookie(url,'invalid=blocked; SameSite=None',true);
  const visible=data.documentCookies(url);assert.equal(visible.sandstone_revision,revision);
  assert.equal(visible.cookies.some(cookie=>cookie.key==='private'),false);assert.doesNotMatch(JSON.stringify(visible),/secret/);
  data.clear('cookie.test',{localStorage:false});assert.equal(data.documentCookies(url).sandstone_revision,revision+1);
  assert.deepEqual(changes,['cookie.test','cookie.test','unrelated.test','cookie.test']);
  const secure=new SiteDataStore();secure.setCookie(url,'secure=protected; Secure; Path=/',true);
  assert.equal(secure.documentCookies(url).cookies.length,1);
  assert.doesNotMatch(JSON.stringify(secure.documentCookies('http://cookie.test/path/page')),/protected/);
  for(const local of ['http://localhost/','http://127.0.0.1/','http://[::1]/','http://sub.localhost/']){
    const data=new SiteDataStore();data.setCookie(local,'secure=local; Secure; Path=/',true);
    assert.equal(data.documentCookies(local).cookies.some(cookie=>cookie.key==='secure'),true,local);
  }
});
