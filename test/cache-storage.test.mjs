import test from 'node:test';
import assert from 'node:assert/strict';
import {CacheService} from '../src/cache/service.mjs';
import {create_cache_api} from '../src/cache/client.mjs';
import {create_request_class} from '../src/frame/request.mjs';
import {remember_response,response_metadata} from '../src/response_metadata.mjs';

test('Cache snapshots preserve trusted response metadata across property shadowing and clones',async()=>{
  const {api}=environment(),cache=await api.caches.open('metadata');
  const response=remember_response(new Response('body',{headers:{'x-original':'yes'}}),{url:'https://cache.test/final#section',type:'cors',redirected:true});
  Object.defineProperties(response,{status:{value:206},type:{value:'basic'},url:{value:'https://forged.test/'},headers:{value:new Headers({forged:'yes'})}});
  await cache.put('/entry',response);
  const restored=(await cache.match('/entry')).clone(),metadata=response_metadata(restored);
  assert.equal(metadata.status,200);assert.equal(metadata.type,'cors');assert.equal(metadata.url,'https://cache.test/final#section');assert.equal(metadata.redirected,true);
  assert.equal(restored.url,'https://cache.test/final');
  assert.equal(metadata.headers.get('x-original'),'yes');assert.equal(metadata.headers.has('forged'),false);assert.equal(await restored.text(),'body');
});

const origin='https://cache.test';
function environment(fetch=async request=>new Response(request.url)){
  const service=new CacheService();
  const client=(id,source=origin)=>create_cache_api({command:command=>service.command(id,source,command),fetch,Request:create_request_class(()=>source+'/base/',()=>source+'/page')});
  return {service,client,api:client('one')};
}
test('Cache storage preserves response snapshots, binary bodies and Vary/query matching',async()=>{
  const {api}=environment(),cache=await api.caches.open('assets');
  const response=new Response(new Uint8Array([1,2,255]),{status:404,headers:{vary:'accept-language','x-sandstone-cache-record':'authored'}});
  const key=new Request(origin+'/asset?q=one#fragment',{headers:{'accept-language':'en'}});
  const writing=cache.put(key,response);assert.equal(response.bodyUsed,true);await writing;
  assert.equal(await cache.match(origin+'/asset?q=one'),undefined);
  const found=await cache.match(new Request(origin+'/asset?q=two',{headers:{'accept-language':'en'}}),{ignoreSearch:true});
  assert.equal(found.status,404);assert.equal(found.headers.get('x-sandstone-cache-record'),'authored');
  assert.deepEqual([...new Uint8Array(await found.clone().arrayBuffer())],[1,2,255]);
  assert.deepEqual([...new Uint8Array(await found.arrayBuffer())],[1,2,255]);
  assert.equal((await cache.match(new Request(origin+'/asset?q=one',{method:'POST'}))),undefined);
  assert.ok(await cache.match(new Request(origin+'/asset?q=one',{method:'POST'}),{ignoreMethod:true,ignoreVary:true}));
  assert.equal((await cache.keys()).length,1);assert.equal((await cache.matchAll()).length,1);
  assert.equal(await cache.delete(origin+'/asset?q=two',{ignoreSearch:true,ignoreVary:true}),true);
  assert.equal((await cache.keys()).length,0);
});
test('Cache names and handles share an origin while deletion retains old objects and per-site clearing revokes them',async()=>{
  const {api,service,client}=environment(),old=await api.caches.open('first');
  await old.put('/value',new Response('old'));await api.caches.open('second');
  assert.deepEqual(await api.caches.keys(),['first','second']);
  assert.equal(await (await client('two').caches.match('/value')).text(),'old');
  assert.equal(await client('other','https://other.test').caches.match('/value'),undefined);
  assert.equal(await api.caches.delete('first'),true);assert.equal(await (await old.match('/value')).text(),'old');
  const fresh=await api.caches.open('first');assert.equal(await fresh.match('/value'),undefined);
  assert.deepEqual(await api.caches.keys(),['second','first']);
  await service.clear('cache.test');assert.deepEqual(await api.caches.keys(),[]);
  await assert.rejects(old.put('/value',new Response('resurrection')),{name:'InvalidStateError'});
  assert.deepEqual(await api.caches.keys(),[]);
});
test('Cache addAll fetches through its adapter and rejects failed or duplicate batches without changing entries',async()=>{
  const requests=[],{api}=environment(async request=>{requests.push(request.url);return new Response(request.url,{status:request.url.endsWith('/fail')?500:200});});
  const cache=await api.caches.open('batch');await cache.put('/before',new Response('before'));
  await cache.addAll(['/one','/two']);assert.equal((await cache.keys()).length,3);
  await assert.rejects(cache.addAll(['/new','/fail']),TypeError);assert.equal(await cache.match('/new'),undefined);
  await assert.rejects(cache.addAll(['/duplicate#one','/duplicate#two']),{name:'InvalidStateError'});assert.equal(await cache.match('/duplicate'),undefined);
  const before=requests.length;await assert.rejects(cache.addAll(['data:text/plain,blocked']),TypeError);assert.equal(requests.length,before);
  assert.equal(await (await cache.match('/before')).text(),'before');
});
test('Rejected cache commits restore existing entries and their order before exposing another operation',async()=>{
  const {api,service}=environment(),cache=await api.caches.open('rollback');
  await cache.put('/one',new Response('original one'));await cache.put('/two',new Response('original two'));
  const backing=[...service.handles.values()][0].cache,put=backing.put.bind(backing);let fail=true;
  backing.put=async(request,response)=>{if(fail&&request.url.endsWith('/bad')){fail=false;throw new DOMException('Quota','QuotaExceededError');}return put(request,response);};
  await assert.rejects(cache.addAll(['/one','/bad']),{name:'QuotaExceededError'});
  assert.deepEqual((await cache.keys()).map(key=>key.url),[origin+'/one',origin+'/two']);
  assert.deepEqual(await Promise.all((await cache.matchAll()).map(response=>response.text())),['original one','original two']);
});
test('Cache API rejects invalid receivers, response locks, consumed bodies and unsupported writes',async()=>{
  const {api}=environment(),cache=await api.caches.open('validation');
  assert.throws(()=>new api.Cache(),TypeError);assert.throws(()=>new api.CacheStorage(),TypeError);
  await assert.rejects(api.Cache.prototype.match.call({},'/one'),TypeError);
  await assert.rejects(api.caches.open(Symbol('name')),TypeError);
  await assert.rejects(cache.put('/one',new Response('range',{status:206})),TypeError);
  await assert.rejects(cache.put('/one',new Response('vary',{headers:{vary:'*'}})),TypeError);
  const locked=new Response('locked'),reader=locked.body.getReader();await assert.rejects(cache.put('/locked',locked),TypeError);reader.releaseLock();
  const used=new Response('used');await used.text();await assert.rejects(cache.put('/used',used),TypeError);
  await cache.put('/error',Response.error());assert.equal((await cache.match('/error')).status,0);
  assert.equal(Object.prototype.toString.call(cache),'[object Cache]');assert.equal(Object.prototype.toString.call(api.caches),'[object CacheStorage]');
});

test('Denied cache storage falls back to memory while write quota failures retain the persistent store',async()=>{
  const denied=new CacheService({async keys(){throw new DOMException('Denied','SecurityError');}});await denied.ready;
  assert.equal(denied.persistent,false);const id=await denied.command('client',origin,{method:'open',name:'memory'});assert.ok(id);
  let writes=0;
  const full=new CacheService({async keys(){return [];},async open(){writes++;throw new DOMException('Quota','QuotaExceededError');}});await full.ready;
  assert.equal(full.persistent,true);assert.equal(writes,0);
  await assert.rejects(full.command('client',origin,{method:'open',name:'full'}),{name:'QuotaExceededError'});
  assert.equal(full.persistent,true);
});

test('Failed cache batches abort unfinished sibling fetches and preserve request abort signals',async()=>{
  let cancelled=false;
  const {api}=environment(async(request,{signal})=>{
    signal.throwIfAborted();
    if(request.url.endsWith('/held'))return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{cancelled=true;reject(signal.reason);},{once:true}));
    return new Response('failed',{status:500});
  });
  const cache=await api.caches.open('cancellation');
  await assert.rejects(cache.addAll(['/held','/fail']),TypeError);assert.equal(cancelled,true);assert.deepEqual(await cache.keys(),[]);
  const controller=new AbortController();controller.abort();
  await assert.rejects(cache.add(new Request(origin+'/aborted',{signal:controller.signal})),{name:'AbortError'});
});
