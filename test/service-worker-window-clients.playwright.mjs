import {listen_browser_server} from './browser-server.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';

const worker=`onactivate=event=>event.waitUntil(clients.claim());let saved;
const describe=client=>client&&({path:new URL(client.url).pathname,type:client.type,frameType:client.frameType,visibilityState:client.visibilityState,focused:client.focused});
onmessage=event=>event.waitUntil((async()=>{try{
  const {op,url}=event.data;let value;
  if(op==='capture'){
    const all=await clients.matchAll({includeUncontrolled:true});saved=all.find(client=>new URL(client.url).pathname===(event.data.path||'/app/start'));
    const again=await clients.get(saved.id);value={client:describe(saved),same:again===saved,sameID:again.id===saved.id,sourceSame:await clients.get(event.source.id)===event.source};
  }
  if(op==='snapshot'){const current=await clients.get(saved.id);value={old:describe(saved),current:describe(current),same:current===saved};}
  if(op==='navigate'){
    const current=await clients.get(saved.id),result=await current.navigate(url);
    value={client:describe(result),newID:result&&result.id!==saved.id,same:result===saved,old:describe(saved),oldExists:!!await clients.get(saved.id)};
  }
  if(op==='stale'){await saved.navigate('/app/stale');value='unexpected';}
  if(op==='invalid'){const client=(await clients.matchAll())[0];await client.navigate(url);value='unexpected';}
  if(op==='uncontrolled'){await event.source.navigate('/app/forbidden');value='unexpected';}
  event.ports[0].postMessage({value});
}catch(error){event.ports[0].postMessage({error:error.name});}})());`;
const control='<!doctype html><body><button>Control</button><iframe id="target"></iframe>';
const content='<!doctype html><body><input id="text">Window client';
const setup=`(async()=>{
  globalThis.windowRegistration=await navigator.serviceWorker.register('/app/sw.js');
  globalThis.askWindow=data=>new Promise((resolve,reject)=>{
    const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();reject(new Error('Window client reply timed out: '+data.op));},10000);
    channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();resolve(event.data);};windowRegistration.active.postMessage(data,[channel.port2]);
  });return true;
})()`;
async function listen(server){await listen_browser_server(server);return 'http://127.0.0.1:'+server.address().port;}

export async function verifyServiceWorkerWindowClients(page){
  const nativeHolds=[];
  const server=createServer((request,response)=>{
    const path=new URL(request.url,'http://local').pathname;response.setHeader('cache-control','no-store');
    if(path==='/app/held'){nativeHolds.push(response);return;}
    if(path==='/app/empty'){response.writeHead(204);response.end();return;}
    if(path==='/app/redirect'){response.writeHead(302,{location:'/app/redirected'});response.end();return;}
    response.setHeader('content-type',path==='/app/sw.js'?'text/javascript':'text/html');response.end(path==='/app/sw.js'?worker:path==='/control'?control:content);
  });
  const foreign=createServer((request,response)=>{response.setHeader('content-type','text/html');response.end(content);});
  const origin=await listen(server),foreignOrigin=await listen(foreign),native=await page.context().newPage(),nativeTop=await page.context().newPage(),fixture=await page.context().newPage(),direct=[],errors=[];
  fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});fixture.on('pageerror',error=>errors.push(error.message));
  const read=(target,proxy,script)=>proxy?target.evaluate(script=>main_frame.eval_js(script),script):target.evaluate(script=>globalThis.eval(script),script);
  const wait=async(target,proxy,script)=>{
    const deadline=Date.now()+10000;while(!await read(target,proxy,script)){if(Date.now()>deadline)throw new Error('Window client state timed out: '+script);await new Promise(resolve=>setTimeout(resolve,10));}
  };
  async function waitHeld(target,proxy){
    if(proxy){await target.waitForFunction(()=>globalThis.windowClientHeldSeen);return;}
    const deadline=Date.now()+10000;while(!nativeHolds.length){if(Date.now()>deadline)throw new Error('Native client navigation did not start');await new Promise(resolve=>setTimeout(resolve,10));}
  }
  async function releaseHeld(target,proxy){if(proxy)await target.evaluate(()=>{windowClientHeldSeen=false;windowClientRelease();});else nativeHolds.shift().end(content);}
  async function verify(target,proxy){
    await read(target,proxy,setup);await wait(target,proxy,'windowRegistration.active?.state==="activated"');
    await read(target,proxy,`(async()=>{const frame=document.getElementById('target'),loaded=new Promise(resolve=>frame.onload=resolve);frame.src='/app/start';await loaded;return true;})()`);
    const ask=data=>read(target,proxy,'askWindow('+JSON.stringify(data)+').then(value=>JSON.stringify(value))').then(JSON.parse),result={};
    result.initial=await ask({op:'capture'});
    await read(target,proxy,`document.getElementById('target').contentWindow.history.pushState(null,'','/app/history');document.getElementById('target').contentDocument.getElementById('text').focus();true`);
    result.snapshot=await ask({op:'snapshot'});
    result.fragment=await ask({op:'navigate',url:'/app/history#fragment'});
    result.invalidURL=await ask({op:'invalid',url:'http://['});result.blank=await ask({op:'invalid',url:'about:blank'});result.noContent=await ask({op:'invalid',url:'/app/empty'});result.uncontrolled=await ask({op:'uncontrolled'});
    result.relative=await ask({op:'navigate',url:'../app/next?value#fragment'});result.stale=await ask({op:'stale'});
    await read(target,proxy,`(async()=>{const frame=document.getElementById('target'),loaded=new Promise(resolve=>frame.onload=resolve);frame.src='/app/start';await loaded;return true;})()`);
    await ask({op:'capture'});result.redirect=await ask({op:'navigate',url:'/app/redirect'});
    await read(target,proxy,`(async()=>{const frame=document.getElementById('target'),loaded=new Promise(resolve=>frame.onload=resolve);frame.src='/app/start';await loaded;return true;})()`);
    await ask({op:'capture'});const pending=ask({op:'navigate',url:'/app/held'});await waitHeld(target,proxy);
    await read(target,proxy,`(async()=>{const frame=document.getElementById('target'),loaded=new Promise(resolve=>frame.onload=resolve);frame.src='/app/winner';await loaded;return true;})()`);
    await releaseHeld(target,proxy);result.cancelled=await pending;
    await read(target,proxy,`(async()=>{const frame=document.getElementById('target'),loaded=new Promise(resolve=>frame.onload=resolve);frame.src='/app/start';await loaded;return true;})()`);
    await ask({op:'capture'});result.foreign=await ask({op:'navigate',url:foreignOrigin+'/foreign'});
    result.finalURL=await read(target,proxy,'document.getElementById("target").contentWindow.location.href').catch(()=>null);
    return result;
  }
  try{
    await native.goto(origin+'/control');const expected=await verify(native,false);
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.evaluate(async({origin,worker,control,content})=>{
      sandstone.network.session.fetch=async url=>{
        const path=new URL(url).pathname;
        if(path==='/app/held'){windowClientHeldSeen=true;await new Promise(resolve=>globalThis.windowClientRelease=resolve);}
        if(path==='/app/empty')return new Response(null,{status:204});
        if(path==='/app/redirect')return new Response(null,{status:302,headers:{location:'/app/redirected'}});
        return new Response(path==='/app/sw.js'?worker:path==='/control'?control:content,{headers:{'content-type':path==='/app/sw.js'?'text/javascript':'text/html','cache-control':'no-store'}});
      };
      main_frame.on_load=()=>{};await main_frame.navigate_to(origin+'/control');
    },{origin,worker,control,content});
    await fixture.bringToFront();const actual=await verify(fixture,true);
    assert.deepEqual(actual,expected);assert.equal(expected.initial.value.same,false);assert.equal(expected.snapshot.value.old.focused,false);assert.equal(expected.snapshot.value.current.focused,true);
    assert.equal(expected.relative.value.newID,true);assert.equal(expected.relative.value.oldExists,false);assert.equal(expected.foreign.value.client,null);
    assert.equal(expected.fragment.value.newID,false);assert.equal(expected.fragment.value.oldExists,true);
    await nativeTop.goto(origin+'/app/top');
    const rootAsk=(target,proxy,data)=>read(target,proxy,'askWindow('+JSON.stringify(data)+').then(value=>JSON.stringify(value))').then(JSON.parse);
    await rootAsk(native,false,{op:'capture',path:'/app/top'});const rootFragmentExpected=await rootAsk(native,false,{op:'navigate',url:'/app/top#fragment'});const rootExpected=await rootAsk(native,false,{op:'navigate',url:'top-next'});
    await fixture.evaluate(async origin=>{globalThis.windowClientTarget=new sandstone.controller.ProxyFrame();windowClientTarget.on_load=()=>{};document.body.append(windowClientTarget.iframe);await windowClientTarget.navigate_to(origin+'/app/top');},origin);
    await rootAsk(fixture,true,{op:'capture',path:'/app/top'});const rootFragmentActual=await rootAsk(fixture,true,{op:'navigate',url:'/app/top#fragment'});const rootActual=await rootAsk(fixture,true,{op:'navigate',url:'top-next'});
    const rootSummary=result=>({path:result.value.client.path,frameType:result.value.client.frameType,newID:result.value.newID,oldExists:result.value.oldExists});
    assert.deepEqual(rootSummary(rootActual),rootSummary(rootExpected));assert.deepEqual(rootSummary(rootActual),{path:'/app/top-next',frameType:'top-level',newID:true,oldExists:false});
    assert.deepEqual(rootSummary(rootFragmentActual),rootSummary(rootFragmentExpected));assert.equal(rootFragmentActual.value.newID,false);assert.equal(rootFragmentActual.value.oldExists,true);
    assert.equal(await fixture.evaluate(()=>windowClientTarget.url.pathname),'/app/top-next');
    await rootAsk(native,false,{op:'capture',path:'/app/top-next'});const nativePending=rootAsk(native,false,{op:'navigate',url:'/app/held'});await waitHeld(native,false);await nativeTop.goto(origin+'/app/top-winner');await releaseHeld(native,false);
    const nativeCancelled=await nativePending;
    await rootAsk(fixture,true,{op:'capture',path:'/app/top-next'});const proxyPending=rootAsk(fixture,true,{op:'navigate',url:'/app/held'});await waitHeld(fixture,true);await fixture.evaluate(origin=>windowClientTarget.navigate_to(origin+'/app/top-winner'),origin);await releaseHeld(fixture,true);
    assert.deepEqual(await proxyPending,nativeCancelled);assert.deepEqual(nativeCancelled,{error:'TypeError'});assert.deepEqual(actual.cancelled,{error:'TypeError'});assert.deepEqual(actual.noContent,{error:'TypeError'});
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Worker client lookups return independent native snapshots of focus and creation URLs','WindowClient.navigate resolves worker-relative URLs and returns the replacement document client','Discarded and uncontrolled clients reject navigation without changing another page','Worker client redirects and cross-origin navigation use the relay and preserve native results','Worker-driven top-level document navigation stays on the relay and returns the new client','Superseded top-level/iframe and no-content worker navigations retain native rejection behavior','Worker fragment navigations retain the existing top-level and iframe document clients'];
  }finally{
    await fixture.evaluate(origin=>sandstone.service_workers.clear_registrations(new URL(origin).hostname),origin).catch(()=>{});
    await Promise.all([native.close(),nativeTop.close(),fixture.close()]);for(const item of [server,foreign]){item.closeAllConnections();await new Promise(resolve=>item.close(resolve));}
  }
}
