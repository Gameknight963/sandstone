import test from 'node:test';
import assert from 'node:assert/strict';
import {ServiceWorkerNavigations} from '../src/service_worker/navigation.mjs';
import {fetch_with_cookies} from '../src/host/request.mjs';
import {SiteDataStore} from '../src/host/site_data.mjs';

function environment({route,transport,timeout=1000}={}){
  const clients=new Map(),records=[],requests=[],events=[],frames={root:{id:'root',root_id:'root',url:new URL('https://app.test/old'),document_context:'old',broadcast_origin:'https://app.test'}};let next=0;
  const manager={clients,list:async origin=>records.filter(record=>new URL(record.scope).origin===origin),addClient(value){const client={...value,controller:null,registration:null};clients.set(client.id,client);return client;},removeClient:id=>clients.delete(id),control:(client,registration,controller)=>Object.assign(client,{registration,controller}),requestActivation(){},collect(){}};
  const data=new SiteDataStore();
  const navigation=new ServiceWorkerNavigations({manager,frames:()=>frames,timeout,id:()=>String(++next),route:async(url,options,context,fallback)=>{events.push({url,options,context});return route?route(url,options,context):fallback();}});
  const network=(url,options,context,worker)=>fetch_with_cookies(async(url,options)=>{requests.push({url,options});return transport?transport(url,options):new Response('<body>network',{headers:{'content-type':'text/html'}});},data,url,options,context,worker);
  const context={navigation:true,navigation_target:'root',navigation_owner:'root',navigation_previous:'old',url:'https://app.test/old',top_url:'https://app.test/old'};
  const fetch=(url='https://app.test/page',options={},ctx=context)=>navigation.fetch(url,options,ctx,network);
  const close=()=>{for(const lease of [...navigation.pending.values()])lease.release();};
  return {navigation,manager,records,requests,events,frames,context,data,fetch,close};
}
test('A selected worker supplies document HTML and its reserved client survives until authenticated commit',async()=>{
  const api=environment({route:()=>new Response('<body>cached',{headers:{'content-type':'text/html','set-cookie':'forged=yes'}})});
  const record={scope:'https://app.test/',active:{id:'worker'}};api.records.push(record);
  try{
    const response=await api.fetch();assert.equal(await response.text(),'<body>cached');assert.equal(api.requests.length,0);
    assert.equal(api.events[0].options.mode,'navigate');assert.equal(api.events[0].options.redirect,'manual');assert.equal(api.events[0].options.referrer,'https://app.test/old');
    const lease=api.navigation.response(response);assert.equal(lease.client.reserved,true);assert.equal(lease.client.controller,record.active);assert.equal(api.data.cookies.getCookieStringSync('https://app.test/'),'');
    const selected=record.active;record.active={id:'replacement'};api.frames.root.url=new URL(response.url);
    assert.equal(api.navigation.commit(api.frames.root,lease),lease.client.id);assert.equal(lease.client.controller,selected);assert.equal(lease.client.frame,'root');assert.equal(api.navigation.pending.size,0);
  }finally{api.close();}
});
test('HTTP redirects enter destination worker scopes and worker redirects select the final controller',async()=>{
  const api=environment({transport:()=>new Response(null,{status:302,headers:{location:'https://other.test/one/page'}}),route:url=>url.includes('/one/')?new Response(null,{status:302,headers:{location:'/two/page'}}):new Response('<body>second',{headers:{'content-type':'text/html'}})});
  const one={scope:'https://other.test/one/',active:{id:'one'}},two={scope:'https://other.test/two/',active:{id:'two'}};api.records.push(one,two);
  try{
    const response=await api.fetch();assert.equal(response.url,'https://other.test/two/page');assert.equal(response.redirected,true);assert.equal(await response.text(),'<body>second');
    assert.deepEqual(api.events.map(event=>event.context.service_worker_navigation.id),['1','1']);assert.equal(api.navigation.response(response).client.controller,two.active);assert.equal(api.requests.length,1);
  }finally{api.close();}
});
test('Aborting a stalled registration lookup removes the reservation without waiting or resurrecting it',async()=>{
  const api=environment(),controller=new AbortController();let release;api.manager.list=()=>new Promise(resolve=>release=resolve);
  const pending=api.fetch(undefined,{signal:controller.signal});controller.abort();await assert.rejects(pending,{name:'AbortError'});
  assert.equal(api.manager.clients.size,0);release([]);await new Promise(setImmediate);assert.equal(api.requests.length,0);assert.equal(api.manager.clients.size,0);
});
test('Parent retirement cancels child reservations while an incoming replacement can be retained for commit',async()=>{
  const api=environment();
  try{
    const root=await api.fetch();await root.text();const child=await api.fetch('https://app.test/child',{}, {...api.context,navigation_target:'child',nested:true});await child.text();
    api.navigation.disconnect('root',{keep_navigation:true});assert.equal(api.navigation.pending.size,1);assert.equal(api.navigation.reserved(api.navigation.response(child).client.id),false);
    api.frames.root.document_context='replacement';api.frames.root.url=new URL(root.url);
    assert.equal(api.navigation.commit(api.frames.root,api.navigation.response(root)),undefined);assert.equal(api.manager.clients.size,0);
  }finally{api.close();}
});
test('Uncommitted reservations expire and downloaded documents release them after draining the body',async()=>{
  const api=environment({timeout:10});const response=await api.fetch();await response.text();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(api.navigation.pending.size,0);assert.equal(api.manager.clients.size,0);
  const downloads=environment({transport:()=>new Response('file',{headers:{'content-type':'application/octet-stream'}})});
  try{const file=await downloads.fetch();assert.equal(downloads.navigation.response(file),undefined);assert.equal(await file.text(),'file');assert.equal(downloads.manager.clients.size,0);}finally{downloads.close();}
});

test('No-content responses release their incoming clients without committing a document',async()=>{
  for(const status of [204,205]){
    const api=environment({transport:()=>new Response(null,{status})});
    const response=await api.fetch();assert.equal(response.status,status);assert.equal(api.navigation.response(response),undefined);assert.equal(api.manager.clients.size,0);assert.equal(api.navigation.pending.size,0);
  }
});

test('Only the originating parent document can cancel its pending incoming child',async()=>{
  const api=environment();
  try{
    const response=await api.fetch('https://app.test/child',{}, {...api.context,navigation_target:'child',nested:true});await response.text();
    api.navigation.cancel('child','root','previous-document');assert.equal(api.navigation.pending.size,1);
    api.navigation.cancel('child','root','old');assert.equal(api.navigation.pending.size,0);assert.equal(api.manager.clients.size,0);
  }finally{api.close();}
});

test('Network fallback reads cookies after worker startup and dispatch have completed',async()=>{
  let api;
  api=environment({route:()=>{api.data.setCookie('https://app.test/','login=ready; Path=/');}});
  api.records.push({scope:'https://app.test/',active:{id:'worker'}});
  try{const response=await api.fetch();await response.text();assert.equal(api.requests[0].options.headers.cookie,'login=ready');}finally{api.close();}
});

test('A discarded first-document frame cannot commit a reservation with an undefined owner token',async()=>{
  const api=environment(),frame=api.frames.root;frame.document_context=undefined;
  const response=await api.fetch();await response.text();frame.url=new URL(response.url);delete api.frames.root;
  assert.equal(api.navigation.commit(frame,api.navigation.response(response)),undefined);assert.equal(api.manager.clients.size,0);assert.equal(api.navigation.pending.size,0);
});
