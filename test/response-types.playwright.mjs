import {listen_browser_server} from './browser-server.mjs';
import assert from 'node:assert/strict';
import {wait_for} from './wait-for.mjs';
import {createServer} from 'node:http';
import {once} from 'node:events';

const worker=`onactivate=event=>event.waitUntil(clients.claim());onfetch=event=>{
  const path=new URL(event.request.url).pathname;
  if(path==='/synthetic')event.respondWith(new Response('synthetic',{headers:{'x-private':'visible'}}));
  if(path==='/pass')event.respondWith(fetch(event.request));
  if(path==='/cached-image')event.respondWith(caches.open('response-types').then(cache=>cache.match('/opaque-image')));
  if(path==='/cached-cors')event.respondWith(caches.open('response-types').then(cache=>cache.match('/cors-data')));
};`;
function resource(input){
  const url=new URL(input),path=url.pathname;
  const body=path==='/client'?'<!doctype html><body>Response types':path==='/sw.js'?worker:path==='/image.svg'?'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"/>':'response body';
  const headers={'content-type':path==='/sw.js'?'text/javascript':path==='/client'?'text/html':path==='/image.svg'?'image/svg+xml':'text/plain',
    'cache-control':'no-store','content-length':String(new TextEncoder().encode(body).length),connection:'close',
    'access-control-allow-origin':'*','access-control-expose-headers':url.searchParams.get('expose')||'x-visible','x-visible':'yes','x-private':'secret','set-cookie':'hidden=yes; Path=/'};
  if(url.searchParams.get('credential')==='yes'){headers['access-control-allow-origin']=url.searchParams.get('origin');headers['access-control-allow-credentials']='true';}
  if(path==='/redirect')return {status:302,statusText:'Found',headers:{...headers,location:url.searchParams.get('to')||'/data'},body};
  return {status:200,statusText:'OK',headers,body};
}
async function api(cross){
  const describe=async response=>{
    const url=response.url?new URL(response.url):null;
    const result={status:response.status,statusText:response.statusText,ok:response.ok,type:response.type,url:url?url.pathname+url.search+url.hash:'',redirected:response.redirected,headers:[...response.headers],bodyNull:response.body===null,body:await response.text(),used:response.bodyUsed};
    try{Headers.prototype.set.call(response.headers,'x-added','value');result.mutable=true;}catch(error){result.mutable=error.name;}
    return result;
  };
  const results={};
  for(const [name,url,init] of [
    ['same','/data',{}],['sameNoCors','/data',{mode:'no-cors'}],['cors',cross+'/data',{credentials:'omit'}],['opaque',cross+'/data',{mode:'no-cors'}],
    ['wildcard',cross+'/data?expose=*',{credentials:'omit'}],
    ['credentials',cross+'/data?expose=*&credential=yes&origin='+encodeURIComponent(location.origin),{credentials:'include'}],
    ['manual',cross+'/redirect',{mode:'no-cors',redirect:'manual'}],
    ['manualData',cross+'/data',{mode:'no-cors',redirect:'manual'}],['errorData',cross+'/data',{mode:'no-cors',redirect:'error'}],
    ['keepalive',cross+'/data',{mode:'no-cors',keepalive:true}]
  ]){
    try{const response=await fetch(url,init),clone=Response.prototype.clone.call(response);results[name]={response:await describe(response),clone:await describe(clone)};}
    catch(error){results[name]={error:error.name};}
  }
  const cache=await caches.open('response-types'),opaque=await fetch(cross+'/image.svg',{mode:'no-cors'});
  await cache.put('/opaque-image',opaque);results.opaqueCache={used:opaque.bodyUsed,response:await describe(await cache.match('/opaque-image'))};
  const cors=await fetch(cross+'/data?expose=*',{credentials:'omit'});await cache.put('/cors-data',cors);
  results.corsCache=await describe(await cache.match('/cors-data'));
  const modified=await cache.match('/cors-data');modified.headers.set('x-visible','changed');modified.headers.set('x-added','new');modified.headers.delete('x-private');results.modifiedCorsClone=[...Response.prototype.clone.call(modified).headers];results.modifiedCorsCloneOwn=[...modified.clone().headers];await cache.put('/cors-data',modified);results.modifiedCorsHeaders=[...(await cache.match('/cors-data')).headers];
  const opaqueModified=await cache.match('/opaque-image');opaqueModified.headers.set('x-added','new');results.modifiedOpaqueClone=[...Response.prototype.clone.call(opaqueModified).headers];await cache.put('/opaque-image',opaqueModified);results.modifiedOpaqueHeaders=[...(await cache.match('/opaque-image')).headers];
  return results;
}
async function controlled(cross){
  const read=async(url,options)=>{const response=await fetch(url,options);return {type:response.type,status:response.status,headers:[...response.headers],body:await response.text()};};
  const results={};
  for(const [name,url,options] of [['synthetic','/synthetic',{}],['crossSynthetic',cross+'/synthetic',{mode:'no-cors'}],['pass',cross+'/pass',{mode:'no-cors'}],['cached','/cached-cors',{credentials:'include'}]])results[name]=await read(url,options);
  results.image=await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve({width:image.naturalWidth,height:image.naturalHeight});image.onerror=()=>reject(new Error('Cached opaque image did not load'));image.src='/cached-image';document.body.append(image);});
  return results;
}
function normalize(value){return JSON.parse(JSON.stringify(value).replaceAll(/https?%3A%2F%2F[^&"]+/g,'ENCODED_ORIGIN'));}
export async function verifyResponseTypes(page){
  const server=createServer((request,response)=>{const data=resource('http://'+request.headers.host+request.url);response.sendDate=false;response.writeHead(data.status,data.statusText,data.headers);response.end(data.body);});
  await listen_browser_server(server);const origin='http://127.0.0.1:'+server.address().port,cross=origin.replace('127.0.0.1','localhost');
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage(),fixture=await page.context().newPage(),errors=[],direct=[];
  const read=(fn,argument)=>fixture.evaluate(({fn,argument})=>main_frame.eval_js('(async()=>JSON.stringify(await ('+fn+')('+JSON.stringify(argument)+')))()'),{fn:fn.toString(),argument}).then(JSON.parse);
  fixture.on('pageerror',error=>errors.push(error.message));
  try{
    await native.goto(origin+'/client');const expected=await native.evaluate(api,cross);
    assert.equal(expected.cors.response.type,'cors');assert.equal(expected.opaque.response.type,'opaque');assert.equal(expected.opaqueCache.used,true);
    await native.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;});await native.waitForFunction(()=>!!navigator.serviceWorker.controller);
    const expectedControlled=await native.evaluate(controlled,cross);assert.deepEqual(expectedControlled.image,{width:4,height:3});
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
    await fixture.evaluate(({fn,worker})=>{const resource=eval('('+fn+')');sandstone.network.session.fetch=async url=>{const data=resource(url);return new Response(data.body,{status:data.status,statusText:data.statusText,headers:data.headers});};},{fn:resource.toString(),worker});
    await fixture.evaluate(()=>main_frame.navigate_to('https://response-types.test/client'));
    assert.deepEqual(normalize(await read(api,'https://cross-response-types.test')),normalize(expected));
    await fixture.evaluate(()=>main_frame.eval_js('(async()=>{await navigator.serviceWorker.register("/sw.js");await navigator.serviceWorker.ready;})()'));await wait_for(()=>fixture.evaluate(async()=>!!await main_frame.eval_js('!!navigator.serviceWorker.controller')));
    assert.deepEqual(await read(controlled,'https://cross-response-types.test'),expectedControlled);
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Basic, CORS and opaque fetch responses preserve native headers, URL visibility, cloning and cache consumption','CORS wildcard credentials and cached exposure lists match native Chromium','Service workers return cached opaque image bodies and retain synthetic/pass-through response types'];
  }finally{await fixture.close();await nativeContext.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await page.bringToFront();}
}
