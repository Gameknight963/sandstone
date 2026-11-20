import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';

const worker=`onmessage=async event=>{try{const {clientId,...value}=await(await fetch(event.data)).json(),entry=globalThis.entryInfo;postMessage({serviceWorker:'serviceWorker' in navigator,value,entry:entry?{creator:!!entry.creator,result:!!entry.result,different:entry.creator!==entry.result,matched:clientId===entry.result,mode:entry.mode,destination:entry.destination}:null});}catch(error){postMessage({error:error.message});}};`;
const service=`const entries=new Map();oninstall=()=>skipWaiting();onactivate=event=>event.waitUntil(clients.claim());onfetch=event=>{const path=new URL(event.request.url).pathname;if(path==='/app/redirect.js'){event.respondWith(Response.redirect(new URL('/outside.js',event.request.url)));return;}if(event.request.destination==='worker'){const ready=clients.get(event.resultingClientId).then(client=>client?.type==='worker'&&client.frameType==='none');entries.set(event.resultingClientId,ready);event.waitUntil(ready);event.respondWith(new Response('globalThis.entryInfo='+JSON.stringify({creator:event.clientId,result:event.resultingClientId,mode:event.request.mode,destination:event.request.destination})+';'+${JSON.stringify(worker)},{headers:{'content-type':'text/javascript'}}));}else if(path==='/value')event.respondWith((async()=>{const client=await clients.get(event.clientId);return Response.json({controlled:true,clientId:event.clientId,type:client?.type,frameType:client?.frameType,listed:(await clients.matchAll({type:'worker'})).some(value=>value.id===client?.id),ready:entries.has(event.clientId)?await entries.get(event.clientId):null});})());};`;
async function exercise(worker){
  await navigator.serviceWorker.register('/sw.js',{scope:'/app/'});await navigator.serviceWorker.ready;
  if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
  const blob=URL.createObjectURL(new Blob([worker],{type:'text/javascript'})),results=[];
  try{
    for(const [name,url,type] of [['classic','/app/worker.js','classic'],['module','/app/worker.js','module'],['redirect-in','/start.js','classic'],['redirect-out','/app/redirect.js','classic'],['outside','/outside.js','classic'],['blob',blob,'classic'],['data','data:text/javascript,'+encodeURIComponent(worker),'classic']]){
      const instance=new Worker(url,{type});
      try{
        const value=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Worker timed out: '+name)),8000);instance.onmessage=event=>{clearTimeout(timer);resolve(event.data);};instance.onerror=event=>{clearTimeout(timer);reject(new Error(event.message));};instance.postMessage(location.origin+'/value');});
        results.push({name,...value});
      }finally{instance.terminate();}
    }
    return results;
  }finally{URL.revokeObjectURL(blob);}
}

export async function verifyServiceWorkerWorkerClients(page){
  const server=createServer((request,response)=>{
    const path=new URL(request.url,'http://local').pathname;
    if(path==='/start.js'){response.writeHead(302,{location:'/app/worker.js'});response.end();return;}
    response.setHeader('access-control-allow-origin','*');
    response.setHeader('content-type',path.endsWith('.js')?'text/javascript':path==='/value'?'application/json':'text/html');
    response.end(path==='/sw.js'?service:path.endsWith('.js')?worker:path==='/value'?'{"controlled":false}':'<!doctype html><body>Worker clients');
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  const native=await page.context().newPage(),fixture=await page.context().newPage(),origin='https://worker-client.test',errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
  try{
    await native.goto('http://127.0.0.1:'+server.address().port+'/app/page');
    const expected=await native.evaluate(exercise,worker);
    assert.deepEqual(expected.map(value=>[value.name,value.value?.controlled]),[['classic',true],['module',true],['redirect-in',true],['redirect-out',false],['outside',false],['blob',true],['data',false]]);
    for(const value of expected){if(['classic','module','redirect-in'].includes(value.name)){assert.deepEqual(value.entry,{creator:true,result:true,different:true,matched:true,mode:'same-origin',destination:'worker'});assert.equal(value.value.ready,true);}else assert.equal(value.entry,null);}
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.evaluate(async({origin,worker,service})=>{
      await sandstone.service_workers.clear_registrations(new URL(origin).hostname);
      sandstone.network.session.fetch=async url=>{const path=new URL(url).pathname;if(path==='/start.js')return new Response(null,{status:302,headers:{location:'/app/worker.js'}});return new Response(path==='/sw.js'?service:path.endsWith('.js')?worker:path==='/value'?'{"controlled":false}':'<!doctype html><body>Worker clients',{headers:{'content-type':path.endsWith('.js')?'text/javascript':path==='/value'?'application/json':'text/html','cache-control':'no-store','access-control-allow-origin':'*'}});};
      main_frame.on_load=()=>{};await main_frame.navigate_to(origin+'/app/page');
    },{origin,worker,service});
    const actual=await fixture.evaluate(source=>main_frame.eval_js(source),'('+exercise.toString()+')('+JSON.stringify(worker)+')');
    assert.deepEqual(actual,expected);
    await fixture.waitForFunction(()=>![...sandstone.service_workers.manager.clients.values()].some(client=>client.type==='worker'));
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Classic and module worker fetches use their script scope controller','Worker entry scripts use their own scope and expose creator/resulting client IDs','Blob workers inherit controllers and data workers remain uncontrolled','Service workers can inspect and list dedicated-worker clients','Terminated workers release service-worker clients'];
  }finally{
    await fixture.evaluate(origin=>sandstone.service_workers.clear_registrations(new URL(origin).hostname),origin).catch(()=>{});
    await native.close();await fixture.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
}
