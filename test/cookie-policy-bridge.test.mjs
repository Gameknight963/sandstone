import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {SiteDataStore} from '../src/host/site_data.mjs';
import {CookiePolicyBridge,cookie_policy_handler} from '../src/host/cookie_policy_bridge.mjs';
import {fetch_with_cookies} from '../src/host/request.mjs';

const origin='https://worker.test';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(){
  const store=new SiteDataStore(),handle=cookie_policy_handler(store),calls=[];
  const bridge=new CookiePolicyBridge(async(message)=>{calls.push(structuredClone(message));await setImmediate();return structuredClone(await handle(message));});
  return {store,handle,bridge,calls};
}

test('Asynchronous worker cookie policy sends HttpOnly cookies and commits redirect cookies before the next hop',async()=>{
  const {store,bridge,calls}=fixture();store.setCookie(origin,'session=secret; HttpOnly; Path=/',true);
  const requests=[];
  const response=await fetch_with_cookies(async(url,init)=>{
    requests.push({url,headers:init.headers});
    return requests.length===1?new Response(null,{status:302,headers:{location:'/next','set-cookie':'redirected=yes; HttpOnly; Path=/'}}):new Response('body');
  },bridge,origin+'/start',{credentials:'include'},{url:origin+'/worker.js'});
  assert.equal(await response.text(),'body');assert.equal(requests[0].headers.cookie,'session=secret');assert.equal(requests[1].headers.cookie,'session=secret; redirected=yes');
  assert.equal(store.cookies.getCookieStringSync(origin),'session=secret; redirected=yes');
  assert.deepEqual(calls.map(value=>value.op),['capture','header','set','header']);
});

test('A worker cookie provider preserves one clear barrier across redirects and late HTTP responses',async()=>{
  const {store,bridge}=fixture(),held=deferred(),started=deferred();let count=0;
  store.setCookie(origin,'old=before; Path=/');
  const pending=fetch_with_cookies(async()=>{
    if(++count===1)return new Response(null,{status:302,headers:{location:'/next','set-cookie':'redirect=before; Path=/'}});
    started.resolve();return held.promise;
  },bridge,origin+'/start',{}, {url:origin+'/worker.js'});
  await started.promise;store.clear('worker.test',{cookies:true,localStorage:false});store.setCookie(origin,'fresh=after; Path=/');
  held.resolve(new Response('done',{headers:[['set-cookie','old=restored; Path=/'],['set-cookie','fresh=deleted; Max-Age=0; Path=/']]}));
  await(await pending).text();assert.equal(store.cookies.getCookieStringSync(origin),'fresh=after');
});

test('Cookie policy omits credentials and skips providers for synthetic worker responses',async()=>{
  const {bridge,calls}=fixture();
  await fetch_with_cookies(()=>new Response(null),bridge,origin,{credentials:'omit'},{url:origin});
  assert.deepEqual(calls,[]);
  const response=await fetch_with_cookies(()=>{throw new Error('Unexpected transport');},bridge,origin,{}, {url:origin},()=>new Response('synthetic',{headers:{'set-cookie':'forged=yes'}}));
  assert.equal(await response.text(),'synthetic');assert.deepEqual(calls.map(value=>value.op),['capture']);
  const unavailable=new CookiePolicyBridge(()=>{throw new Error('No live cookie provider');});
  assert.equal(await(await fetch_with_cookies(()=>new Response('public'),unavailable,origin,{credentials:'omit'},{url:origin})).text(),'public');
});

test('Aborting while a cookie provider is stalled promptly rejects without starting a transport',async()=>{
  const controller=new AbortController(),held=deferred(),entered=deferred();let transported=false;
  const bridge=new CookiePolicyBridge(message=>{if(message.op==='capture')return {};entered.resolve();return held.promise;});
  const pending=fetch_with_cookies(()=>{transported=true;return new Response(null);},bridge,origin,{signal:controller.signal},{url:origin});
  await entered.promise;controller.abort();await assert.rejects(pending,{name:'AbortError'});
  held.reject(new Error('Late disconnected provider'));await setImmediate();assert.equal(transported,false);
});

test('A failed response cookie commit cancels the HTTP body and prevents the next redirect',async()=>{
  let cancelled=false,count=0;
  const bridge=new CookiePolicyBridge(message=>{if(message.op==='set')throw new Error('Provider closed');return message.op==='capture'?{}:'';});
  await assert.rejects(fetch_with_cookies(()=>{count++;return new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:302,headers:{location:'/next','set-cookie':'session=secret'}});},bridge,origin,{}, {url:origin}),/Provider closed/);
  assert.equal(count,1);assert.equal(cancelled,true);
});

test('A cookie policy captures clearing epochs before waiting for host initialization',async()=>{
  const store=new SiteDataStore(),ready=deferred();store.ready=ready.promise;
  const handle=cookie_policy_handler(store),captured=handle({op:'capture',context:{}});
  store.clear('worker.test',{cookies:true,localStorage:false});ready.resolve();
  await handle({op:'set',url:origin,value:'late=forbidden; Path=/',options:await captured});
  assert.equal(store.cookies.getCookieStringSync(origin),'');
});
