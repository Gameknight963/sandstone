import test from 'node:test';
import assert from 'node:assert/strict';
import {request_referrer,request_origin,parse_referrer_policy} from '../src/referrer.mjs';
import {fetch_with_cookies} from '../src/host/request.mjs';
import {SiteDataStore} from '../src/host/site_data.mjs';
import {serialize_request} from '../src/frame/polyfill/request.mjs';

test('Referrer policies strip credentials/fragments and distinguish origins and downgrades',()=>{
  const source='https://user:password@site.test/path?q=1#private',same='https://site.test/next',cross='https://other.test/',down='http://other.test/';
  const full='https://site.test/path?q=1',origin='https://site.test/';
  for(const [policy,expected] of Object.entries({
    'no-referrer':['','',''],'same-origin':[full,'',''],'origin':[origin,origin,origin],
    'strict-origin':[origin,origin,''],'origin-when-cross-origin':[full,origin,origin],
    'strict-origin-when-cross-origin':[full,origin,''],'unsafe-url':[full,full,full],
    'no-referrer-when-downgrade':[full,full,'']
  }))assert.deepEqual([same,cross,down].map(target=>request_referrer(source,target,policy)),expected,policy);
  assert.equal(parse_referrer_policy('unknown, origin, no-referrer'),'no-referrer');
  assert.equal(parse_referrer_policy('unknown','same-origin'),'same-origin');
  assert.equal(request_referrer('data:text/html,hello',same,'unsafe-url'),'');
  assert.equal(request_referrer('https://site.test/'+ 'a'.repeat(4100),same,'unsafe-url'),origin);
});

test('Origin headers follow CORS, method, redirect taint and referrer policy rules',()=>{
  const source='https://site.test/path',target='https://other.test/';
  assert.equal(request_origin(source,target),null);
  assert.equal(request_origin(source,target,{mode:'cors',cors:true}),'https://site.test');
  assert.equal(request_origin(source,target,{mode:'cors',method:'POST',policy:'no-referrer'}),'https://site.test');
  assert.equal(request_origin(source,target,{mode:'navigate',method:'POST',policy:'no-referrer'}),'null');
  assert.equal(request_origin(source,target,{mode:'no-cors',method:'POST',policy:'same-origin'}),'https://site.test');
  assert.equal(request_origin(source,'http://other.test/',{method:'POST',mode:'navigate'}),'null');
  assert.equal(request_origin(source,target,{method:'POST',tainted:true}),'null');
});

test('Relayed API requests use the virtual page and discard supplied Origin/Referer headers',async()=>{
  const seen=[],store=new SiteDataStore();
  const response=await fetch_with_cookies(async(url,options)=>{seen.push({url,...options});return new Response('ok');},store,'https://site.test/api',{
    method:'POST',mode:'cors',body:'saved',headers:{Origin:'https://forged.test',Referer:'file:///private/path'}
  },{url:'https://site.test/settings?tab=1#password'});
  assert.equal(seen[0].headers.origin,'https://site.test');
  assert.equal(seen[0].headers.referer,'https://site.test/settings?tab=1');
  assert.equal(seen[0].mode,undefined);assert.equal(seen[0].referrer,undefined);
  assert.equal(response.request_referrer,'https://site.test/settings?tab=1');
});

test('Redirects taint Origin, reduce referrers and honor response referrer policy changes',async()=>{
  const seen=[],store=new SiteDataStore();
  await fetch_with_cookies(async(url,options)=>{
    seen.push({url,...options});
    if(seen.length===1)return new Response(null,{status:302,headers:{Location:'https://b.test/login'}});
    if(seen.length===2)return new Response(null,{status:307,headers:{Location:'https://c.test/finish','Referrer-Policy':'no-referrer'}});
    return new Response('done');
  },store,'https://a.test/start',{method:'POST',body:'saved',mode:'cors'},{url:'https://a.test/private?q=1'});
  assert.deepEqual(seen.map(value=>value.headers.origin),['https://a.test','https://a.test','null']);
  assert.deepEqual(seen.map(value=>value.headers.referer),['https://a.test/private?q=1','https://a.test/',undefined]);
  assert.deepEqual(seen.map(value=>value.method),['POST','GET','GET']);
});

test('Font requests send document Origin for local and remote resources with anonymous credentials',async()=>{
  const store=new SiteDataStore(),seen=[];
  store.setCookie('https://site.test/','font=own; SameSite=Lax; Secure; Path=/');
  store.setCookie('https://cdn.test/','font=cross; SameSite=None; Secure; Path=/');
  for(const url of ['https://site.test/font.ttf','https://cdn.test/font.ttf']){
    await fetch_with_cookies(async(url,options)=>{seen.push(options);return new Response('font');},store,url,
      {mode:'cors',credentials:'same-origin',destination:'font',referrer:'https://cdn.test/style.css',referrerPolicy:'unsafe-url'},
      {url:'https://site.test/page'});
  }
  assert.deepEqual(seen.map(value=>value.headers.origin),['https://site.test','https://site.test']);
  assert.deepEqual(seen.map(value=>value.headers.cookie),['font=own',undefined]);
  assert.deepEqual(seen.map(value=>value.headers.referer),['https://cdn.test/style.css','https://cdn.test/style.css']);
  assert.ok(seen.every(value=>!('destination' in value)));
});

test('Cross-site form submissions and nested navigations do not gain destination SameSite cookies',async()=>{
  const store=new SiteDataStore();
  for(const cookie of ['strict=s; SameSite=Strict; Secure; Path=/','lax=l; SameSite=Lax; Secure; Path=/','none=n; SameSite=None; Secure; Path=/'])store.setCookie('https://destination.test/',cookie);
  for(const [method,nested,expected] of [['POST',false,'none=n'],['GET',false,'lax=l; none=n'],['GET',true,'none=n']]){
    let actual;
    await fetch_with_cookies(async(url,options)=>{actual=options.headers.cookie;return new Response('ok');},store,'https://destination.test/submit',{method},{url:'https://source.test/form',navigation:true,nested});
    assert.equal(actual,expected,method+' nested='+nested);
  }
});

test('Request serialization retains mode, explicit virtual referrers and privacy choices',async()=>{
  const request=await serialize_request('/api',{referrer:'/chosen#hash',referrerPolicy:'origin',mode:'same-origin'},'https://site.test/page');
  assert.equal(request.options.referrer,'https://site.test/chosen#hash');
  assert.equal(request.options.referrerPolicy,'origin');assert.equal(request.options.mode,'same-origin');
  assert.equal((await serialize_request('/api',{referrer:''},'https://site.test/page')).options.referrer,'');
  assert.equal((await serialize_request('/api',{referrer:'https://other.test/private'},'https://site.test/page')).options.referrer,'about:client');
  const based=await serialize_request('api',{referrer:'https://site.test/chosen'},'https://cdn.test/assets/','https://site.test/page');
  assert.equal(based.url,'https://cdn.test/assets/api');assert.equal(based.options.referrer,'https://site.test/chosen');
});
