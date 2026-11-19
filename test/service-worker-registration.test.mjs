import test from 'node:test';
import assert from 'node:assert/strict';
import {normalize_registration,validate_registration_response,select_registration} from '../src/service_worker/registration.mjs';
import {trustworthy_url} from '../src/trustworthy.mjs';

const context={base:'https://site.test/app/page.html',origin:'https://site.test'};
const normalize=(url,options={})=>normalize_registration(url,options,context);
const response=(headers={},status=200)=>new Response([204,205,304].includes(status)?null:'// worker',{status,headers:{'Content-Type':'text/javascript',...headers}});

test('Service worker script defaults use its directory while explicit scope uses the document base',()=>{
  assert.deepEqual(normalize('../workers/sw.js?v=2#source'),{scriptURL:'https://site.test/workers/sw.js?v=2',scope:'https://site.test/workers/',origin:'https://site.test',type:'classic',updateViaCache:'imports'});
  assert.equal(normalize('../workers/sw.js',{scope:'./#scope',type:'module',updateViaCache:'none'}).scope,'https://site.test/app/');
  assert.equal(normalize('../workers/sw.js',{scope:'/app?mode=1#fragment'}).scope,'https://site.test/app?mode=1');
});

test('Registration conversion reads Web IDL dictionaries once and before parsing URLs',()=>{
  const calls=[],input={toString(){calls.push('script');return 'http://[';}};
  const options={get scope(){calls.push('scope');return {toString(){calls.push('scope text');return '/';}};},get type(){calls.push('type');return 'classic';},get updateViaCache(){calls.push('cache');return 'all';}};
  assert.throws(()=>normalize(input,options),TypeError);
  assert.deepEqual(calls,['script','scope','scope text','type','cache']);
  let cacheRead=false;
  assert.throws(()=>normalize('/sw.js',{type:'invalid',get updateViaCache(){cacheRead=true;return 'all';}}),TypeError);
  assert.equal(cacheRead,false);
  for(const value of [1,true,'options'])assert.throws(()=>normalize('/sw.js',value),TypeError);
  assert.equal(normalize('/sw.js',null).type,'classic');
  for(const value of [null,'MODULE',Symbol('module')])assert.throws(()=>normalize('/sw.js',{type:value}),TypeError);
  for(const value of [null,'force-cache',Symbol('cache')])assert.throws(()=>normalize('/sw.js',{updateViaCache:value}),TypeError);
  assert.throws(()=>normalize(Symbol('script')),TypeError);
});

test('Registration rejects unsupported schemes and encoded path separators without rejecting URL queries',()=>{
  for(const value of ['data:text/javascript,','blob:https://site.test/id','file:///sw.js','ftp://site.test/sw.js','/a%2fb/sw.js','/a%5Cb/sw.js'])assert.throws(()=>normalize(value),TypeError,value);
  for(const scope of ['data:text/javascript,','/a%2fb/','/a%5cb/'])assert.throws(()=>normalize('/sw.js',{scope}),TypeError,scope);
  assert.equal(normalize('/sw.js?query=%2f%5c').scriptURL,'https://site.test/sw.js?query=%2f%5c');
  // Chromium preserves userinfo in script/scope identities; origin checks do
  // not turn URL credentials into a different origin.
  assert.equal(normalize('https://user:password@site.test/app/sw.js').scope,'https://user:password@site.test/app/');
});

test('Registration principals are virtual trustworthy origins rather than the standalone host',()=>{
  for(const url of ['https://other.test/sw.js','http://site.test/sw.js'])assert.throws(()=>normalize(url),{name:'SecurityError'});
  assert.throws(()=>normalize('/sw.js',{scope:'https://other.test/'}),{name:'SecurityError'});
  for(const origin of ['null','file:///host.html','http://site.test'])assert.throws(()=>normalize_registration('/sw.js',{}, {...context,origin}),{name:'SecurityError'});
  assert.equal(normalize_registration('https://site.test/sw.js',{}, {base:'file:///standalone.html',origin:'https://site.test'}).origin,'https://site.test');
  for(const origin of ['http://localhost','http://app.localhost','http://localhost.','http://127.0.0.2','http://[::1]']){
    assert.equal(trustworthy_url(new URL(origin)),true);
    assert.equal(normalize_registration('/sw.js',{}, {base:origin+'/page'}).origin,new URL(origin).origin);
  }
  for(const origin of ['http://localhost.evil.test','http://128.0.0.1','ftp://localhost','file:///page'])assert.equal(trustworthy_url(new URL(origin)),false);
});

test('Service worker entry responses enforce JavaScript MIME, successful status, and no redirect',()=>{
  const registration=normalize('/app/sw.js');
  for(const status of [200,204,205,206])assert.doesNotThrow(()=>validate_registration_response(registration,response({},status)));
  for(const mime of ['application/javascript; charset=UTF-8','Text/JavaScript','text/x-javascript'])assert.doesNotThrow(()=>validate_registration_response(registration,response({'Content-Type':mime})));
  for(const mime of ['', 'text/plain','application/json','text/html'])assert.throws(()=>validate_registration_response(registration,response({'Content-Type':mime})),{name:'SecurityError'});
  const missing=response();missing.headers.delete('content-type');assert.throws(()=>validate_registration_response(registration,missing),{name:'SecurityError'});
  for(const status of [301,304,400,404,500])assert.throws(()=>validate_registration_response(registration,response({},status)),TypeError);
  const redirected=response();Object.defineProperty(redirected,'redirected',{value:true});
  assert.throws(()=>validate_registration_response(registration,redirected),{name:'SecurityError'});
  const crossOrigin=response();Object.defineProperty(crossOrigin,'url',{value:'https://other.test/sw.js'});
  assert.throws(()=>validate_registration_response(registration,crossOrigin),{name:'SecurityError'});
});

test('Service-Worker-Allowed bounds scopes by path and never permits a different origin',()=>{
  const registration=normalize('/workers/sw.js',{scope:'/app?mode=1'});
  assert.throws(()=>validate_registration_response(registration,response()),{name:'SecurityError'});
  for(const allowed of ['/','../','https://site.test/app?ignored=query#fragment','/app'])assert.doesNotThrow(()=>validate_registration_response(registration,response({'Service-Worker-Allowed':allowed})));
  for(const allowed of ['/workers/','https://other.test/','http://site.test/','http://['])assert.throws(()=>validate_registration_response(registration,response({'Service-Worker-Allowed':allowed})),{name:'SecurityError'});
  assert.throws(()=>validate_registration_response(normalize('/workers/sw.js'),response({'Service-Worker-Allowed':''})),{name:'SecurityError'});
  assert.doesNotThrow(()=>validate_registration_response(normalize('/app/sw.js',{scope:'/application'}),response({'Service-Worker-Allowed':'/app'})));
});

test('Service worker client matching selects the longest serialized scope with origin isolation',()=>{
  const broad=normalize('/sw.js'),app=normalize('/app/sw.js'),query=normalize('/sw.js',{scope:'/app/page?mode=1'}),foreign={scope:'https://other.test/'};
  assert.equal(select_registration([foreign,broad,app,query],'https://site.test/app/page?mode=1#anchor'),query);
  assert.equal(select_registration([broad,app,query],'https://site.test/app/page?mode=2'),app);
  assert.equal(select_registration([app,foreign],'https://site.test/elsewhere'),null);
  assert.equal(select_registration([foreign,broad],'https://site.test/page'),broad);
  assert.throws(()=>select_registration([foreign],'https://other.test/page','https://site.test'),{name:'SecurityError'});
});
