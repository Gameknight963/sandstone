import {listen_browser_server} from './browser-server.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';

// Compare actual Chromium service-worker redirects with the same source in a
// standalone proxy. The proxy's final HTTP adapter records its request headers.
export async function verifyServiceWorkerRedirects(page){
  const received=new Map(),nativeCounts=[];let origin,cross,source;
  const seed='redirect-session=secret; Path=/; SameSite=Strict';
  const server=createServer((request,response)=>{
    const url=new URL(request.url,origin);
    response.setHeader('access-control-allow-origin',request.headers.origin||origin);response.setHeader('access-control-allow-credentials','true');
    if(url.pathname==='/sw.js'){response.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});response.end(source);return;}
    if(url.pathname==='/client'){response.writeHead(200,{'content-type':'text/html','set-cookie':seed});response.end('<!doctype html><body>Worker redirect control');return;}
    if(url.pathname==='/start'||url.pathname==='/middle'){
      response.writeHead(307,{location:(url.pathname==='/start'?cross+'/middle':origin+'/end')+url.search});response.end();return;
    }
    if(url.pathname==='/count'){
      const index=Number(url.searchParams.get('index'));nativeCounts.push(index);
      response.writeHead(302,{location:'/count?index='+(index+1)});response.end();return;
    }
    if(url.pathname==='/end')received.set(url.searchParams.get('case'),request.headers);
    response.writeHead(200,{'content-type':'text/plain','access-control-allow-origin':request.headers.origin||origin,'access-control-allow-credentials':'true'});response.end('done');
  });
  await listen_browser_server(server,'0.0.0.0');
  origin='http://127.0.0.1:'+server.address().port;cross='http://localhost:'+server.address().port;
  source=`onactivate=event=>event.waitUntil(clients.claim());
    onfetch=event=>{const url=new URL(event.request.url);
      if(url.pathname==='/count'&&Number(url.searchParams.get('index'))<10){event.respondWith(Response.redirect(${JSON.stringify(origin)}+'/count?index='+(Number(url.searchParams.get('index'))+1),302));return;}
      if(url.searchParams.get('kind')==='http')return;
      if(url.pathname==='/start')event.respondWith(Response.redirect(${JSON.stringify(cross)}+'/middle'+url.search,307));
      if(url.pathname==='/middle'&&url.searchParams.get('kind')!=='mixed')event.respondWith(Response.redirect(${JSON.stringify(origin)}+'/end'+url.search,307));
    };`;
  const native=await page.context().browser().newContext(),fixture=await page.context().newPage(),direct=[],errors=[];
  fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});fixture.on('pageerror',error=>errors.push(error.message));
  const script=`(async()=>{for(const kind of ['synthetic','mixed','http'])for(const mode of ['cors','no-cors'])for(const credentials of ['include','same-origin']){
    const response=await fetch('/start?kind='+kind+'&case='+kind+'-'+mode+'-'+credentials,{method:'POST',body:'posted',mode,credentials});await response.text();
  }})()`;
  const selected=headers=>Object.fromEntries(['origin','referer','cookie','sec-fetch-site','sec-fetch-mode'].map(key=>[key,headers[key]??null]));
  try{
    const control=await native.newPage();await control.goto(origin+'/client');
    await control.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;});
    await control.waitForFunction(()=>!!navigator.serviceWorker.controller);
    await control.evaluate(script);
    assert.equal(received.size,12,'Each native redirect must reach its final network endpoint');
    await assert.rejects(control.evaluate(()=>fetch('/count?index=0')),/Failed to fetch/);
    assert.deepEqual(nativeCounts,Array.from({length:21},(_,index)=>index+10));
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.evaluate(async({origin,source,seed})=>{
      globalThis.redirectRequests=[];globalThis.redirectCounts=[];
      sandstone.network.session.fetch=async(url,options)=>{
        const path=new URL(url).pathname;
        if(path==='/end')redirectRequests.push({key:new URL(url).searchParams.get('case'),headers:options.headers});
        if(path==='/start'||path==='/middle')return new Response(null,{status:307,headers:{location:(path==='/start'?origin.replace('127.0.0.1','localhost')+'/middle':origin+'/end')+new URL(url).search}});
        if(path==='/count'){
          const index=Number(new URL(url).searchParams.get('index'));redirectCounts.push(index);
          return new Response(null,{status:302,headers:{location:'/count?index='+(index+1)}});
        }
        return new Response(path==='/sw.js'?source:path==='/client'?'<!doctype html><body>Worker redirect fixture':'done',{
          headers:{'content-type':path==='/sw.js'?'text/javascript':path==='/client'?'text/html':'text/plain','cache-control':'no-store',...(path==='/client'?{'set-cookie':seed}:{})}
        });
      };
      main_frame.on_load=()=>{};await main_frame.navigate_to(origin+'/client');
      // Browser-created Response headers can filter Set-Cookie. Seed the
      // private jar directly, matching the native control's server cookie.
      sandstone.controller.site_data.setCookie(origin+'/',seed);
      if(!sandstone.controller.site_data.cookies.getCookieStringSync(origin+'/').includes('redirect-session=secret'))throw new Error('Proxy cookie seed was not stored');
      const manager=sandstone.service_workers.manager;
      globalThis.redirectClient=manager.addClient({id:main_frame.document_context,frame:main_frame.id,url:main_frame.url.href});
      globalThis.redirectRecord=await manager.register(origin+'/sw.js',{}, {base:origin+'/client',origin});await manager.settled(redirectRecord);
    },{origin,source,seed});
    await fixture.evaluate(script=>main_frame.eval_js(script),script);
    const actual=await fixture.evaluate(()=>redirectRequests);assert.equal(actual.length,12);
    for(const request of actual){
      const expected=selected(received.get(request.key));
      assert.deepEqual(selected(request.headers),expected,request.key);
    }
    assert.equal(await fixture.evaluate(()=>main_frame.eval_js(`fetch('/count?index=0').then(()=>null,error=>error.name)`)),'TypeError');
    assert.deepEqual(await fixture.evaluate(()=>redirectCounts),nativeCounts);
    await fixture.waitForFunction(()=>redirectRecord.active.pending===0);
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Synthetic, mixed and HTTP redirects match native Chromium cookies, credentials, Origin, Referer and Fetch Metadata','Network fallback retains its own native redirect budget after worker-generated redirects'];
  }finally{
    await fixture.evaluate(async()=>{
      if(globalThis.redirectRecord)sandstone.controller.site_data.setCookie(redirectRecord.origin+'/','redirect-session=; Max-Age=0; Path=/');
      if(globalThis.redirectRecord)await sandstone.service_workers.clear_registrations(new URL(redirectRecord.origin).hostname);
      if(globalThis.redirectClient)sandstone.service_workers.manager.removeClient(redirectClient.id);
    }).catch(()=>{});
    await fixture.close();await native.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
}
