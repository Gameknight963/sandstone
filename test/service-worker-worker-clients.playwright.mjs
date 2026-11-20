import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';

const worker=`onmessage=async event=>{try{postMessage({serviceWorker:'serviceWorker' in navigator,value:await(await fetch(event.data)).json()});}catch(error){postMessage({error:error.message});}};`;
const service=`oninstall=()=>skipWaiting();onactivate=event=>event.waitUntil(clients.claim());onfetch=event=>{if(new URL(event.request.url).pathname==='/value')event.respondWith((async()=>{const client=await clients.get(event.clientId);return Response.json({controlled:true,type:client?.type,frameType:client?.frameType,listed:(await clients.matchAll({type:'worker'})).some(value=>value.id===client?.id)});})());};`;
async function exercise(worker){
  await navigator.serviceWorker.register('/sw.js',{scope:'/app/'});await navigator.serviceWorker.ready;
  if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
  const blob=URL.createObjectURL(new Blob([worker],{type:'text/javascript'})),results=[];
  try{
    for(const [name,url,type] of [['classic','/app/worker.js','classic'],['module','/app/worker.js','module'],['outside','/outside.js','classic'],['blob',blob,'classic'],['data','data:text/javascript,'+encodeURIComponent(worker),'classic']]){
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
    response.setHeader('access-control-allow-origin','*');
    response.setHeader('content-type',path.endsWith('.js')?'text/javascript':path==='/value'?'application/json':'text/html');
    response.end(path==='/sw.js'?service:path.endsWith('.js')?worker:path==='/value'?'{"controlled":false}':'<!doctype html><body>Worker clients');
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  const native=await page.context().newPage(),fixture=await page.context().newPage(),origin='https://worker-client.test',errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
  try{
    await native.goto('http://127.0.0.1:'+server.address().port+'/app/page');
    const expected=await native.evaluate(exercise,worker);
    assert.deepEqual(expected.map(value=>[value.name,value.value?.controlled]),[['classic',true],['module',true],['outside',false],['blob',true],['data',false]]);
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.evaluate(async({origin,worker,service})=>{
      await sandstone.service_workers.clear_registrations(new URL(origin).hostname);
      sandstone.network.session.fetch=async url=>{const path=new URL(url).pathname;return new Response(path==='/sw.js'?service:path.endsWith('.js')?worker:path==='/value'?'{"controlled":false}':'<!doctype html><body>Worker clients',{headers:{'content-type':path.endsWith('.js')?'text/javascript':path==='/value'?'application/json':'text/html','cache-control':'no-store','access-control-allow-origin':'*'}});};
      main_frame.on_load=()=>{};await main_frame.navigate_to(origin+'/app/page');
    },{origin,worker,service});
    const actual=await fixture.evaluate(source=>main_frame.eval_js(source),'('+exercise.toString()+')('+JSON.stringify(worker)+')');
    assert.deepEqual(actual,expected);
    await fixture.waitForFunction(()=>![...sandstone.service_workers.manager.clients.values()].some(client=>client.type==='worker'));
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Classic and module worker fetches use their script scope controller','Blob workers inherit controllers and data workers remain uncontrolled','Service workers can inspect and list dedicated-worker clients','Terminated workers release service-worker clients'];
  }finally{
    await fixture.evaluate(origin=>sandstone.service_workers.clear_registrations(new URL(origin).hostname),origin).catch(()=>{});
    await native.close();await fixture.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
}
