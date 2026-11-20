import test from 'node:test';
import assert from 'node:assert/strict';
import {ServiceWorkerFetch} from '../src/service_worker/fetch.mjs';
import {fetch_with_cookies,snapshot_request_context} from '../src/host/request.mjs';
import {SiteDataStore} from '../src/host/site_data.mjs';

const context={url:'https://app.test/page',top_url:'https://app.test/page'};
function environment(handler=()=>({type:'response',metadata:{status:200,headers:[]},body:true})){
  const events=[],jobs=[],networks=[];
  const client={id:'client',controller:{state:'activated'},registration:{}};
  const manager={async dispatch(record,worker,event,options){
    events.push(event);assert.equal(options.waitHandled,true);
    const job={handledCalls:[],canceled:[],aborts:[],reads:0,
      result:Promise.resolve().then(()=>handler(event)),lifetime:Promise.resolve(),
      async read(){return ++this.reads===1?{done:false,value:Uint8Array.of(65,66)}:{done:true};},
      async handled(error){this.handledCalls.push(error);},async cancel(reason){this.canceled.push(reason);},async abort(reason){this.aborts.push(reason);}};
    jobs.push(job);return job;
  }};
  const router=new ServiceWorkerFetch({manager,client:()=>client});
  const network=async(url,options)=>{networks.push({url,options});return new Response('network');};
  return {router,client,events,jobs,networks,network,fetch:(url='https://app.test/data',options={},ctx=context)=>router.fetch(url,options,ctx,network)};
}
test('Controlled fetches stream worker responses without entering the HTTP pipeline',async()=>{
  const api=environment(),response=await api.fetch();
  assert.equal(response.url,'https://app.test/data');assert.equal(api.jobs[0].reads,0);
  assert.equal(await response.text(),'AB');assert.equal(api.jobs[0].reads,2);
  assert.deepEqual(api.jobs[0].handledCalls,[undefined]);assert.equal(api.networks.length,0);
});
test('Worker requests expose virtual context without transport cookies or security headers',async()=>{
  const api=environment();const response=await api.fetch(undefined,{method:'POST',body:Uint8Array.of(7),mode:'cors',destination:'image',referrerPolicy:'origin',headers:{cookie:'secret',origin:'https://forged.test',referer:'https://forged.test',host:'wrong','sec-fetch-site':'same-origin',authorization:'token','x-authored':'yes'}});
  const event=api.events[0];assert.equal(event.clientId,'client');
  assert.deepEqual(event.request.headers,[['authorization','token'],['x-authored','yes']]);
  assert.equal(event.request.virtualReferrer,'https://app.test/');assert.equal(event.request.destination,'image');
  assert.equal(event.request.body[0],7);await response.body.cancel();
});
test('Uncontrolled, navigation and bypass requests use the network without dispatching',async()=>{
  const api=environment();
  for(const flags of [{navigation:true},{service_worker_bypass:true}])assert.equal(await (await api.fetch(undefined,{},flags)).text(),'network');
  api.client.controller=null;assert.equal(await (await api.fetch()).text(),'network');
  assert.equal(api.events.length,0);assert.equal(api.networks.length,3);
});
test('An unhandled fetch falls through once, while worker rejection remains a network error',async()=>{
  const api=environment(()=>({type:'fallback'}));assert.equal(await (await api.fetch()).text(),'network');
  assert.equal(api.networks.length,1);assert.deepEqual(api.jobs[0].handledCalls,[undefined]);
  const broken=environment(()=>{throw new TypeError('Rejected respondWith');});
  await assert.rejects(broken.fetch(),/Rejected respondWith/);assert.equal(broken.networks.length,0);
});
test('Synthetic responses cannot set cookies and HEAD cancels rather than reading a body',async()=>{
  const api=environment(()=>({type:'response',metadata:{status:200,headers:[['set-cookie','secret=value'],['x-result','ok']]},body:true}));
  const response=await api.fetch(undefined,{method:'HEAD'});
  assert.equal(response.body,null);assert.equal(response.headers.has('set-cookie'),false);assert.equal(response.headers.get('x-result'),'ok');
  assert.equal(api.jobs[0].reads,0);assert.equal(api.jobs[0].canceled.length,1);
});
test('Abort rejects before response headers and forwards abort/cancel to the worker',async()=>{
  let resolve;const api=environment(()=>new Promise(yes=>resolve=yes)),controller=new AbortController();
  const pending=api.fetch(undefined,{signal:controller.signal});
  await new Promise(setImmediate);controller.abort();
  await assert.rejects(pending,{name:'AbortError'});await new Promise(setImmediate);
  assert.equal(api.jobs[0].aborts.length,1);assert.equal(api.jobs[0].canceled.length>=1,true);
  resolve({type:'fallback'});await new Promise(setImmediate);assert.equal(api.networks.length,0);
});
test('Abort after headers errors body readers and cancels the worker stream',async()=>{
  const api=environment(),controller=new AbortController();const response=await api.fetch(undefined,{signal:controller.signal});
  const reader=response.body.getReader();assert.equal((await reader.read()).done,false);controller.abort();
  await assert.rejects(reader.read(),{name:'AbortError'});await new Promise(setImmediate);assert.equal(api.jobs[0].aborts.length,1);
});
test('Synthetic redirects re-enter workers, convert POST and strip credentials across origins',async()=>{
  const api=environment(event=>event.request.url==='https://app.test/data'?{type:'response',metadata:{status:302,headers:[['location','https://other.test/result']]},body:false}:{type:'fallback'});
  const response=await api.fetch(undefined,{method:'POST',body:'form',headers:{authorization:'secret','content-type':'text/plain'}});
  assert.equal(response.redirected,true);assert.equal(await response.text(),'network');
  assert.equal(api.events.length,2);const next=api.events[1].request;
  assert.equal(next.method,'GET');assert.equal(next.body,undefined);assert.deepEqual(next.headers,[]);
});
test('Worker redirects retain the current fragment until a Location explicitly replaces it',async()=>{
  for(const [fragment,expected] of [['','#kept'],['#next','#next'],['#','']]){
    const api=environment(event=>new URL(event.request.url).pathname==='/start'?{type:'response',metadata:{status:302,headers:[['location','/middle'+fragment]]},body:false}:new URL(event.request.url).pathname==='/middle'?{type:'response',metadata:{status:307,headers:[['location','/end']]},body:false}:{type:'response',metadata:{status:200,headers:[]},body:false});
    const response=await api.fetch('https://app.test/start#kept');assert.equal(response.url,'https://app.test/end'+expected);assert.equal(response.redirected,true);
  }
});

test('Manual and disallowed redirects never issue a destination request',async()=>{
  const api=environment(()=>({type:'response',metadata:{status:302,headers:[['location','/next']]},body:true}));
  const manual=await api.fetch(undefined,{redirect:'manual'});
  assert.equal(manual.status,302);assert.equal(manual.headers.get('location'),'/next');await manual.body.cancel();
  await assert.rejects(api.fetch(undefined,{redirect:'error'}),/Redirect disallowed/);assert.equal(api.networks.length,0);
});

test('Synthetic redirects preserve the reduced referrer while fallback starts a fresh network request',async()=>{
  const urls=['https://app.test/start','https://other.test/middle','https://app.test/end'];
  for(const mode of ['cors','no-cors'])for(const credentials of ['include','same-origin']){
    const run=async synthetic=>{
      const data=new SiteDataStore(),requests=[];
      for(const origin of ['https://app.test','https://other.test']){
        data.setCookie(origin+'/','strict=original; Secure; SameSite=Strict; Path=/');
        data.setCookie(origin+'/','lax=original; Secure; SameSite=Lax; Path=/');
        data.setCookie(origin+'/','none=original; Secure; SameSite=None; Path=/');
      }
      const transport=async(url,options)=>{
        requests.push({url,options});const index=urls.indexOf(url);
        return index<2?new Response(null,{status:307,headers:{location:urls[index+1]}}):new Response('done',{headers:{'set-cookie':'strict=replaced; Secure; SameSite=Strict; Path=/'}});
      };
      const network=(url,options,context)=>fetch_with_cookies(transport,data,url,options,context);
      const options={method:'POST',mode,credentials,body:'posted',headers:{authorization:'secret'}};
      let response;
      if(synthetic){
        const api=environment(event=>{
          const index=urls.indexOf(event.request.url);
          return index<2?{type:'response',metadata:{status:307,headers:[['location',urls[index+1]]]},body:false}:{type:'fallback'};
        });
        response=await api.router.fetch(urls[0],options,context,network);
        assert.equal(api.events.length,3);
      }else response=await network(urls[0],options,context);
      assert.equal(await response.text(),'done');assert.equal(response.request_cross_origin,!synthetic);
      return {headers:requests.at(-1).options.headers,cookie:data.cookies.getCookieStringSync('https://app.test/')};
    };
    const actual=await run(true),expected=await run(false);
    assert.equal(actual.headers['sec-fetch-site'],'same-origin');assert.equal(actual.headers.origin,'https://app.test');
    assert.equal(actual.headers.authorization,undefined);assert.equal(actual.headers.cookie,'strict=original; lax=original; none=original');
    assert.match(actual.cookie,/strict=replaced/);assert.equal(actual.headers.referer,'https://app.test/');
    assert.equal(expected.headers['sec-fetch-site'],'cross-site');assert.equal(expected.headers.origin,'null');
    const allowed=credentials==='include'||mode==='no-cors';
    assert.equal(expected.headers.cookie,allowed?'strict=original; lax=original; none=original':undefined);
    assert.match(expected.cookie,allowed?/strict=replaced/:/strict=original/);
  }
});

test('Network fallback follows its own redirect budget after worker-generated redirects',async()=>{
  const api=environment(event=>{
    const index=Number(new URL(event.request.url).pathname.slice(1));
    return index<10?{type:'response',metadata:{status:302,headers:[['location','/'+(index+1)]]},body:false}:{type:'fallback'};
  });
  const reached=[];
  const network=(url,options,ctx)=>fetch_with_cookies(async url=>{
    const index=Number(new URL(url).pathname.slice(1));reached.push(index);
    return new Response(null,{status:302,headers:{location:'/'+(index+1)}});
  },new SiteDataStore(),url,options,ctx);
  await assert.rejects(api.router.fetch('https://app.test/0',{},context,network),/Too many redirects/);
  assert.deepEqual(reached,Array.from({length:21},(_,index)=>index+10));
});

test('A cross-site ancestor still withholds Strict/Lax cookies after a round-trip redirect',async()=>{
  const data=new SiteDataStore(),headers=[];
  for(const value of ['strict=original; SameSite=Strict','lax=original; SameSite=Lax','none=original; SameSite=None; Secure'])data.setCookie('https://app.test/',value+'; Path=/');
  const response=await fetch_with_cookies(async(url,options)=>{
    headers.push(options.headers);
    if(url==='https://app.test/start')return new Response(null,{status:302,headers:{location:'https://other.test/middle'}});
    if(url==='https://other.test/middle')return new Response(null,{status:302,headers:{location:'https://app.test/end'}});
    return new Response('done',{headers:{'set-cookie':'strict=replaced; SameSite=Strict; Path=/'}});
  },data,'https://app.test/start',{credentials:'include'}, {...context,cross_site:true});
  await response.text();assert.equal(headers[0].cookie,'none=original');assert.equal(headers[1].cookie,undefined);assert.equal(headers[2].cookie,'none=original');
  assert.match(data.cookies.getCookieStringSync('https://app.test/'),/strict=original/);
});

test('A delayed worker fallback cannot restore cookies cleared after its client request was accepted',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;}),api=environment(()=>held),data=new SiteDataStore();
  data.setCookie('https://app.test/','old=before; Path=/');
  const accepted=snapshot_request_context(data,context);
  const pending=api.router.fetch('https://app.test/data',{},accepted,(url,options,source)=>fetch_with_cookies(async()=>
    new Response('network',{headers:[['set-cookie','old=restored; Path=/'],['set-cookie','fresh=deleted; Max-Age=0; Path=/']]}),data,url,options,source));
  data.clear('app.test',{cookies:true,localStorage:false});data.setCookie('https://app.test/','fresh=after; Path=/');
  release({type:'fallback'});
  assert.equal(await(await pending).text(),'network');
  assert.equal(data.cookies.getCookieStringSync('https://app.test/'),'fresh=after');
  assert.deepEqual(api.jobs[0].handledCalls,[undefined]);
});
