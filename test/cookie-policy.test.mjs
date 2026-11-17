import test from 'node:test';
import assert from 'node:assert/strict';
import {SiteDataStore} from '../src/host/site_data.mjs';
import {cookie_header} from '../src/host/cookie_policy.mjs';
import {fetch_with_cookies} from '../src/host/request.mjs';
import {websocket_options} from '../src/host/websocket.mjs';

test('Default SameSite cookies use Lax and allow only recent unsafe top-level navigation',async()=>{
  const store=new SiteDataStore(),url='https://target.test/';
  for(const value of ['default=d','strict=s; SameSite=Strict','lax=l; SameSite=Lax','none=n; SameSite=None; Secure','invalid=i; SameSite=unknown','insecure=x; SameSite=None'])store.setCookie(url,value+'; Path=/');
  assert.equal(cookie_header(store.cookies,url),'default=d; strict=s; lax=l; none=n; invalid=i');
  assert.equal(cookie_header(store.cookies,url,{sameSiteContext:'none'}),'none=n');
  assert.equal(cookie_header(store.cookies,url,{sameSiteContext:'lax'}),'default=d; lax=l; none=n; invalid=i');
  assert.equal(cookie_header(store.cookies,url,{sameSiteContext:'none',allowUnsafe:true}),'default=d; none=n; invalid=i');
  assert.equal(cookie_header(store.cookies,url,{sameSiteContext:'none',allowUnsafe:true,now:Date.now()+120001}),'none=n');
  for(const [method,navigation,nested,expected] of [
    ['GET',false,false,'none=n'],['POST',true,false,'default=d; none=n; invalid=i'],
    ['GET',true,false,'default=d; lax=l; none=n; invalid=i'],['POST',true,true,'none=n']
  ]){
    let cookie;
    await fetch_with_cookies(async(url,options)=>{cookie=options.headers.cookie;return new Response('ok');},store,url,{method},{url:'https://source.test/',navigation,nested});
    assert.equal(cookie,expected);
  }
  assert.equal(websocket_options(store,'wss://target.test/',{url:'https://source.test/'}).headers.Cookie,'none=n');
});

test('Cookie storage rejects insecure None attributes and cross-site response writes without deleting valid cookies',async()=>{
  const store=new SiteDataStore(),url='https://target.test/';
  store.setCookie(url,'session=valid; SameSite=None; Secure; Path=/');
  store.setCookie(url,'session=deleted; SameSite=None; Max-Age=0; Path=/');
  assert.equal(store.cookies.getCookieStringSync(url),'session=valid');
  for(const [navigation,nested,expected] of [[false,false,'session=valid; none=n'],[true,true,'session=valid; none=n'],[true,false,'session=valid; none=n; default=d; lax=l; strict=s']]){
    await fetch_with_cookies(async()=>new Response('ok',{headers:{'Set-Cookie':'default=d; Path=/'}}),store,url,{}, {url:'https://source.test/',navigation,nested});
    for(const value of ['none=n; SameSite=None; Secure','lax=l; SameSite=Lax','strict=s; SameSite=Strict'])store.setCookie(url,value+'; Path=/',true,{crossSite:true,topLevel:navigation&&!nested});
    assert.equal(store.cookies.getCookieStringSync(url),expected);
  }
  const options=websocket_options(store,'wss://target.test/',{url:'https://source.test/'});
  options.onHeader('set-cookie','session=deleted; Max-Age=0; Path=/');
  assert.match(store.cookies.getCookieStringSync(url),/session=valid/);
});
