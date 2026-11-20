import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';

const source=`onactivate=event=>event.waitUntil(clients.claim());onfetch=event=>{
  const url=new URL(event.request.url);
  if(url.pathname==='/nav-redirect')event.respondWith(fetch('/redirect',{redirect:'manual'}));
  if(url.pathname==='/nav-body')event.respondWith(fetch('/absent',{redirect:'manual'}));
  if(url.pathname==='/nav-cache')event.respondWith(caches.open('manual-responses').then(cache=>cache.match('/saved')));
  if(url.pathname==='/nav-cache-redirect')event.respondWith(caches.open('manual-responses').then(cache=>cache.match('/saved-redirect')));
};`;
function resource(input){
  const url=new URL(input),path=url.pathname;
  const headers={'content-type':'text/html;charset=utf-8','cache-control':'no-store','x-secret':'not exposed'};
  if(path==='/sw.js')return {status:200,headers:{...headers,'content-type':'text/javascript'},body:source};
  const location=path==='/redirect'?'/final#next':path==='/nested/redirect'?'final#next':path==='/bad'?'http://[':path==='/data'?'data:text/plain,blocked':path==='/empty'?'':null;
  return {status:['/client','/final','/nested/final'].includes(path)?200:302,headers:{...headers,...(location===null?{}:{location})},body:'<!doctype html><title>Manual response</title><body>secret redirect body'};
}
const api=`(async()=>{
  const results={};
  for(const path of ['/redirect#original','/bad','/data','/empty','/absent']){
    try{
      const response=await fetch(path,{redirect:'manual'}),clone=response.clone(),url=new URL(response.url);
      const value={type:response.type,status:response.status,statusText:response.statusText,ok:response.ok,url:url.pathname+url.search+url.hash,headers:[...response.headers],bodyNull:response.body===null,text:await response.text(),bodyUsed:response.bodyUsed,cloneType:clone.type,cloneStatus:clone.status,borrowedType:Response.prototype.clone.call(clone).type};
      try{response.headers.set('x-added','value');value.mutable=true;}catch(error){value.mutable=error.name;}
      await clone.text();results[path]=value;
    }catch(error){results[path]={error:error.name};}
  }
  const response=await fetch('/absent',{redirect:'manual'}),cache=await caches.open('manual-responses');
  results.cache={before:response.bodyUsed};await cache.put('/saved',response);results.cache.after=response.bodyUsed;
  for(const [name,operation] of [['text',()=>Response.prototype.text.call(response)],['clone',()=>Response.prototype.clone.call(response)],['again',()=>cache.put('/again',response)]])try{await operation();results.cache[name]='accepted';}catch(error){results.cache[name]=error.name;}
  const stored=await cache.match('/saved');results.cache.stored={type:stored.type,status:stored.status,headers:[...stored.headers],bodyNull:stored.body===null,text:await stored.text(),bodyUsed:stored.bodyUsed};
  await cache.put('/saved-redirect',await fetch('/nested/redirect',{redirect:'manual'}));
  results.keepalive=[];for(const path of ['/redirect','/absent']){const response=await fetch(path,{redirect:'manual',keepalive:true});results.keepalive.push({type:response.type,status:response.status,headers:[...response.headers],bodyNull:response.body===null,text:await response.text()});}
  return results;
})()`;

export async function verifyManualRedirects(page){
  const server=createServer((request,response)=>{const value=resource('http://'+request.headers.host+request.url);response.writeHead(value.status,value.headers);response.end(value.body);});
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  const context=await page.context().browser().newContext(),native=await context.newPage(),fixture=await page.context().newPage(),errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));
  const read=expression=>fixture.evaluate(source=>main_frame.eval_js('(async()=>JSON.stringify(await ('+source+')))()'),expression).then(JSON.parse);
  try{
    await native.goto(origin+'/client');const expected=await native.evaluate(code=>eval(code),api);
    assert.equal(expected['/redirect#original'].type,'opaqueredirect');assert.equal(expected.cache.after,true);assert.equal(expected.cache.clone,'TypeError');
    await native.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;});
    await native.waitForFunction(()=>!!navigator.serviceWorker.controller);
    const navigations={};for(const path of ['/nav-redirect','/nav-body','/nav-cache','/nav-cache-redirect']){
      await native.goto(origin+path);navigations[path]=await native.evaluate(()=>({path:location.pathname,hash:location.hash,body:document.body.innerText}));
    }
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
    await fixture.evaluate(({fn,source})=>{
      const resource=eval('('+fn+')');sandstone.network.session.fetch=async url=>{const value=resource(url);return new Response(value.body,{status:value.status,headers:value.headers});};
    },{fn:resource.toString(),source});
    // resource closes over the worker source, so install it explicitly in the
    // page's mocked transport rather than exposing it to the authored client.
    await fixture.evaluate(source=>{const fetch=sandstone.network.session.fetch;sandstone.network.session.fetch=(url,...args)=>new URL(url).pathname==='/sw.js'?Promise.resolve(new Response(source,{headers:{'content-type':'text/javascript','cache-control':'no-store'}})):fetch(url,...args);},source);
    await fixture.evaluate(()=>main_frame.navigate_to('https://manual-redirect.test/client'));
    assert.deepEqual(await read(api),expected);
    await read('(async()=>{await navigator.serviceWorker.register("/sw.js");await navigator.serviceWorker.ready;return true;})()');
    await fixture.waitForFunction(async()=>!!await main_frame.eval_js('!!navigator.serviceWorker.controller'));
    for(const path of ['/nav-redirect','/nav-body','/nav-cache','/nav-cache-redirect']){
      await fixture.evaluate(url=>main_frame.navigate_to(url),'https://manual-redirect.test'+path);
      assert.deepEqual(await read('({path:location.pathname,hash:location.hash,body:document.body.innerText})'),navigations[path],path);
    }
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Manual redirects match native opaque status, immutable headers, null bodies, clones and cache consumption','Service workers can return fetched and cached opaque redirects without exposing their private navigation bodies'];
  }finally{await fixture.close();await context.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await page.bringToFront();}
}
