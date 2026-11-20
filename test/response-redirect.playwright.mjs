import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';

function probe(){
  const results={};
  const cases=[['relative','../login'],['query','?next=1#done'],['empty',''],['undefined',undefined],['absolute','https://elsewhere.test/path'],['data','data:text/plain,hello'],['invalid','http://['],['badStatus','next',200],['wrap','next',65536+303],['negativeWrap','next',-65536+307],['fraction','next',302.9],['bigint','next',1n]];
  for(const [name,...args] of cases){
    try{const response=Response.redirect(...args),copy=Response.prototype.clone.call(response);
      const read=value=>({status:value.status,type:value.type,url:value.url,bodyNull:value.body===null,redirected:value.redirected,location:value.headers.get('location')});
      const normalize=value=>{const {location,...fields}=read(value),url=new URL(location),same=url.origin===globalThis.location.origin;return {...fields,location:{scheme:same?'same':url.protocol,origin:same?'same':url.origin,path:url.pathname,search:url.search,hash:url.hash}};};
      results[name]={response:normalize(response),clone:normalize(copy)};try{response.headers.set('x','y');results[name].mutable=true;}catch(error){results[name].mutable=error.name;}
    }catch(error){results[name]={error:error.name};}
  }
  const log=[];try{Response.redirect({toString(){log.push('url');return 'http://[';}},{valueOf(){log.push('status');return 200;}});}catch(error){results.order={log,error:error.name};}
  try{Response.redirect();results.required='accepted';}catch(error){results.required=error.name;}
  results.shape={name:Response.redirect.name,length:Response.redirect.length,constructor:Response.prototype.constructor===Response};
  return results;
}
const service=`onactivate=event=>event.waitUntil(clients.claim());onfetch=event=>{if(new URL(event.request.url).pathname==='/app/nested/start')event.respondWith(Response.redirect('../finished#done',303));};`;
function resource(input){
  const path=new URL(input).pathname;
  if(path==='/scripts/redirect.js')return {status:302,headers:{location:'/different/worker.js'},type:'text/javascript',body:''};
  if(path==='/scripts/worker.js'||path==='/scripts/module.js'||path==='/different/worker.js')return {type:'text/javascript',body:'postMessage(('+probe.toString()+')());'};
  if(path==='/app/service.js')return {type:'text/javascript',body:service};
  return {type:'text/html',body:'<!doctype html><title>Redirect factory</title><body>Redirect factory'};
}
async function documentCases(fn){
  const results={initial:fn()},base=document.createElement('base');base.href='/assets/base/';document.head.append(base);results.base=fn();
  Object.defineProperty(document,'baseURI',{configurable:true,get(){throw new Error('Authored base getter');}});try{results.shadow=fn();}finally{delete document.baseURI;}
  base.href='https://elsewhere.test/base/';results.cross=fn();base.href='../other/';results.changed=fn();history.pushState(null,'','/history/page');results.frozen=fn();base.remove();results.history=fn();
  const log=[],response=Response.redirect({toString(){log.push('url');base.href='/from-url/';document.head.append(base);return 'next';}},{valueOf(){log.push('status');base.href='/from-status/';return 303;}});results.coercion={path:new URL(response.headers.get('location')).pathname,status:response.status,log};base.remove();
  return results;
}
export async function verifyResponseRedirect(page){
  const server=createServer((request,response)=>{const data=resource('http://'+request.headers.host+request.url);response.writeHead(data.status||200,{'content-type':data.type,'cache-control':'no-store',...data.headers});response.end(data.body);});
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  const context=await page.context().browser().newContext(),native=await context.newPage(),fixture=await page.context().newPage(),errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));
  const read=source=>fixture.evaluate(source=>main_frame.eval_js('(async()=>JSON.stringify(await ('+source+')))()'),source).then(JSON.parse);
  const workers=`(async()=>{const results={};for(const type of ['classic','module'])for(const redirected of [false,true])results[type+(redirected?'-redirected':'')]=await new Promise((resolve,reject)=>{const worker=new Worker('/scripts/'+(redirected?'redirect':type==='classic'?'worker':'module')+'.js',{type});worker.onmessage=event=>{worker.terminate();resolve(event.data);};worker.onerror=event=>{worker.terminate();reject(new Error(event.message));};});return results;})()`;
  try{
    await native.goto(origin+'/app/client');const expected=await native.evaluate(({fn,run})=>eval('('+run+')('+fn+')'),{fn:probe.toString(),run:documentCases.toString()});
    assert.equal(expected.initial.relative.response.location.path,'/login');assert.equal(expected.initial.negativeWrap.response.status,307);
    const expectedWorkers=await native.evaluate(source=>eval(source),workers);
    await native.goto(origin+'/app/client');await native.evaluate(async()=>{await navigator.serviceWorker.register('/app/service.js');await navigator.serviceWorker.ready;});await native.waitForFunction(()=>!!navigator.serviceWorker.controller);
    await native.goto(origin+'/app/nested/start');const expectedNavigation=await native.evaluate(()=>({path:location.pathname,hash:location.hash}));assert.deepEqual(expectedNavigation,{path:'/finished',hash:'#done'});
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
    await fixture.evaluate(({fn,probe,service})=>{const resource=eval('('+fn+')');sandstone.network.session.fetch=async url=>{const data=resource(url);return new Response(data.body,{status:data.status||200,headers:{'content-type':data.type,'cache-control':'no-store',...data.headers}});};},{fn:resource.toString(),probe:probe.toString(),service});
    await fixture.evaluate(()=>main_frame.navigate_to('https://response-redirect.test/app/client'));
    assert.deepEqual(await read('('+documentCases.toString()+')('+probe.toString()+')'),expected);
    assert.deepEqual(await read(workers),expectedWorkers);
    await fixture.evaluate(()=>main_frame.navigate_to('https://response-redirect.test/app/client'));
    await read('(async()=>{await navigator.serviceWorker.register("/app/service.js");await navigator.serviceWorker.ready;return true;})()');await fixture.waitForFunction(async()=>!!await main_frame.eval_js('!!navigator.serviceWorker.controller'));
    await fixture.evaluate(()=>main_frame.navigate_to('https://response-redirect.test/app/nested/start'));
    assert.deepEqual(await read('({path:location.pathname,hash:location.hash})'),expectedNavigation);assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Relative Response.redirect URLs use dynamic document bases and frozen base elements','Classic/module workers and service-worker navigation use their virtual script URL','Redirect factory conversion, clone metadata, status wrapping and immutable headers match Chromium'];
  }finally{await fixture.close();await context.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await page.bringToFront();}
}
