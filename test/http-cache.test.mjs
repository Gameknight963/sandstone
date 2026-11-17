import test from 'node:test';
import assert from 'node:assert/strict';
import {HTTPCache,http_cache} from '../src/host/http_cache.mjs';
import {SiteDataStore} from '../src/host/site_data.mjs';

const context={url:'https://site.test/page',top_url:'https://site.test/'};
function fixture(options={}){
  let time=Date.UTC(2026,0,1),calls=[];
  const cache=new HTTPCache({...options,now:()=>time});
  const response=(body,headers={},status=200)=>new Response(body,{status,headers:{Date:new Date(time).toUTCString(),'Cache-Control':'max-age=60',...headers}});
  const fetch=(url,init={})=>cache.fetch(async(url,options)=>{calls.push({url,...options});return response('body-'+calls.length,{ETag:'"version"'});},url,init,context);
  return {cache,calls,response,fetch,advance:ms=>{time+=ms;}};
}

test('Fresh HTTP entries are reused and stale ETags revalidate without losing their body',async()=>{
  const {cache,calls,response,advance}=fixture();
  const transport=async(url,options)=>{calls.push(options);return calls.length===1?response('original',{ETag:'"one"'}):response(null,{ETag:'"one"','X-Updated':'yes'},304);};
  assert.equal(await (await cache.fetch(transport,'https://site.test/a',{},context)).text(),'original');
  assert.equal(await (await cache.fetch(transport,'https://site.test/a',{},context)).text(),'original');assert.equal(calls.length,1);
  advance(61000);
  const validated=await cache.fetch(transport,'https://site.test/a',{},context);
  assert.equal(validated.status,200);assert.equal(await validated.text(),'original');assert.equal(validated.headers.get('x-updated'),'yes');
  assert.equal(calls[1].headers['if-none-match'],'"one"');
  await (await cache.fetch(transport,'https://site.test/a',{},context)).text();assert.equal(calls.length,2);
});

test('Fetch cache modes preserve reload, no-store, force-cache and cache-only semantics',async()=>{
  const {fetch,calls,advance}=fixture();const url='https://site.test/modes';
  assert.equal(await (await fetch(url)).text(),'body-1');advance(61000);
  assert.equal(await (await fetch(url,{cache:'force-cache'})).text(),'body-1');assert.equal(calls.length,1);
  assert.equal(await (await fetch(url,{cache:'reload'})).text(),'body-2');
  assert.equal(calls[1].headers['if-none-match'],undefined);assert.equal(calls[1].headers['cache-control'],'no-cache');assert.equal(calls[1].headers.pragma,'no-cache');
  assert.equal(await (await fetch(url,{cache:'no-store'})).text(),'body-3');
  assert.equal(await (await fetch(url)).text(),'body-2');
  assert.equal(await (await fetch(url,{cache:'only-if-cached'})).text(),'body-2');
  await assert.rejects(fetch(url+'/missing',{cache:'only-if-cached'}),TypeError);
  assert.equal(await (await fetch(url,{cache:'no-cache'})).text(),'body-4');assert.equal(calls[3].headers['cache-control'],'max-age=0');assert.equal(calls[3].headers['if-none-match'],'"version"');
});

test('Explicit client conditions remain observable 304 responses and never replace cached bodies',async()=>{
  const {cache,response}=fixture();let calls=0;
  const transport=async()=>++calls===1?response('saved',{ETag:'"one"'}):response(null,{},304);
  await (await cache.fetch(transport,'https://site.test/a',{},context)).text();
  const manual=await cache.fetch(transport,'https://site.test/a',{headers:{'If-None-Match':'"one"'}},context);
  assert.equal(manual.status,304);assert.equal(manual.body,null);
  assert.equal(await (await cache.fetch(transport,'https://site.test/a',{},context)).text(),'saved');assert.equal(calls,2);
});

test('Vary selects matching representations, wildcard entries validate and no-store bypasses reuse',async()=>{
  const {cache,response}=fixture();let calls=0;
  const transport=async(url,options)=>response((options.headers['x-language']??'absent')+':'+ ++calls,{Vary:url.endsWith('wild')?'*':'X-Language','Cache-Control':url.endsWith('private')?'no-store':'max-age=60'});
  const get=async(path,language)=> (await cache.fetch(transport,'https://site.test/'+path,{headers:language===undefined?{}:{'X-Language':language}},context)).text();
  assert.equal(await get('vary','en'),'en:1');assert.equal(await get('vary','fr'),'fr:2');assert.equal(await get('vary','en'),'en:1');
  assert.equal(await get('vary'),'absent:3');assert.equal(await get('vary',''),':4');
  await get('wild','en');await get('wild','en');await get('private','en');await get('private','en');assert.equal(calls,8);
});

test('Cache partitions separate credentials, cookies, authorization and source/top-level sites',async()=>{
  const {cache,response}=fixture();let calls=0;
  const transport=async()=>response('private-'+ ++calls,{'Cache-Control':'private, max-age=60'});
  const get=(init={},source=context)=>cache.fetch(transport,'https://cdn.test/a',init,source).then(response=>response.text());
  assert.equal(await get(),'private-1');assert.equal(await get(),'private-1');
  assert.equal(await get({credentials:'omit'}),'private-2');
  assert.equal(await get({headers:{Cookie:'session=one'}}),'private-3');
  assert.equal(await get({headers:{Cookie:'session=two'}}),'private-4');
  assert.equal(await get({headers:{Authorization:'Bearer token'}}),'private-5');
  assert.equal(await get({}, {...context,url:'https://other.test/'}),'private-6');
  assert.equal(await get({}, {...context,top_url:'https://other.test/'}),'private-7');
});

test('Revalidation applies new raw Set-Cookie fields once while cache hits never replay them',async()=>{
  const {cache,response}=fixture();let calls=0;
  const transport=async()=>{
    if(++calls===1)return response('saved',{ETag:'"one"','Set-Cookie':'first=one','Cache-Control':'max-age=0'});
    const output=response(null,{'Cache-Control':'max-age=60'},304);
    Object.defineProperty(output,'raw_headers',{value:[...output.headers,['Set-Cookie','next=two'],['Set-Cookie','other=three']]});return output;
  };
  const initial=await cache.fetch(transport,'https://site.test/a',{},context);assert.equal(initial.headers.get('set-cookie'),'first=one');await initial.text();
  const updated=await cache.fetch(transport,'https://site.test/a',{},context);assert.equal(await updated.text(),'saved');
  assert.deepEqual(updated.raw_headers.filter(([name])=>name.toLowerCase()==='set-cookie').map(([,value])=>value),['next=two','other=three']);
  const hit=await cache.fetch(transport,'https://site.test/a',{},context);assert.equal(hit.headers.get('set-cookie'),null);assert.ok(hit.raw_headers.every(([name])=>name!=='set-cookie'));assert.equal(calls,2);
});

test('Expires, Age and Last-Modified determine freshness and validators',async()=>{
  const {cache,response,advance}=fixture();let calls=0,conditional;
  const modified=new Date(Date.UTC(2025,11,31,23,50)).toUTCString();
  const transport=async(url,options)=>{calls++;conditional=options.headers['if-modified-since'];return response('saved',{'Cache-Control':'','Last-Modified':modified,Age:'30'});};
  await (await cache.fetch(transport,'https://site.test/a',{},context)).text();advance(20000);
  await (await cache.fetch(transport,'https://site.test/a',{},context)).text();assert.equal(calls,1);
  advance(11000);await (await cache.fetch(transport,'https://site.test/a',{},context)).text();assert.equal(calls,2);assert.equal(conditional,modified);
});

test('HEAD responses have empty bodies and do not populate GET with an empty representation',async()=>{
  const {fetch,calls}=fixture();
  const first=await fetch('https://site.test/a',{method:'HEAD'});assert.equal(await first.text(),'');
  const second=await fetch('https://site.test/a',{method:'HEAD'});assert.equal(await second.text(),'');assert.equal(calls.length,1);
  assert.equal(await (await fetch('https://site.test/a')).text(),'body-2');
});

test('Successful unsafe methods invalidate their URL and same-origin related locations',async()=>{
  const {cache,response}=fixture();let calls=0;
  const transport=async(url,options)=>{calls++;return response('body-'+calls,options.method==='POST'?{Location:'/related'}:{});};
  for(const path of ['a','related'])await (await cache.fetch(transport,'https://site.test/'+path,{},context)).text();
  await cache.fetch(transport,'https://site.test/a',{method:'POST'},context);
  for(const path of ['a','related'])await (await cache.fetch(transport,'https://site.test/'+path,{},context)).text();
  assert.equal(calls,5);
});

test('Cache eviction and oversized responses obey memory bounds without truncating page data',async()=>{
  const {cache,fetch,calls}=fixture({maxBytes:5,maxEntryBytes:3,maxEntries:2});
  for(const path of ['a','b'])await (await cache.fetch(async()=>new Response('xx',{'headers':{'Cache-Control':'max-age=60'}}),'https://site.test/'+path,{},context)).text();
  await (await fetch('https://site.test/a')).text();
  await (await cache.fetch(async()=>new Response('cc',{headers:{'Cache-Control':'max-age=60'}}),'https://site.test/c',{},context)).text();
  assert.equal(cache.entries.size,2);assert.equal(cache.bytes,4);
  assert.ok([...cache.entries.values()].some(entry=>entry.url.endsWith('/a')));assert.ok(![...cache.entries.values()].some(entry=>entry.url.endsWith('/b')));
  assert.equal(await (await fetch('https://site.test/large')).text(),'body-1');assert.equal(cache.entries.size,2);assert.equal(cache.pendingBytes,0);assert.equal(calls.length,1);
});

test('Cancellation, transfer failure and clearing during a response never commit partial bytes',async()=>{
  const {cache,response}=fixture();let stream,canceled=false;
  const transport=async()=>response(new ReadableStream({start(controller){stream=controller;},cancel(){canceled=true;}}));
  const output=await cache.fetch(transport,'https://site.test/a',{},context),reader=output.body.getReader();
  stream.enqueue(new Uint8Array([1,2]));await reader.read();await reader.cancel();assert.equal(canceled,true);assert.equal(cache.entries.size,0);assert.equal(cache.pendingBytes,0);
  const failed=await cache.fetch(transport,'https://site.test/b',{},context),consumed=failed.text();stream.error(new Error('offline'));
  await assert.rejects(consumed,/offline/);assert.equal(cache.entries.size,0);assert.equal(cache.pendingBytes,0);
  const cleared=await cache.fetch(transport,'https://site.test/c',{},context);cache.clear('site.test');stream.enqueue(new Uint8Array([3]));stream.close();await cleared.text();assert.equal(cache.entries.size,0);assert.equal(cache.pendingBytes,0);
});

test('Existing site-data clearing also clears partitioned HTTP responses',async()=>{
  http_cache.clear();
  await (await http_cache.fetch(async()=>new Response('cached',{headers:{'Cache-Control':'max-age=60'}}),'https://cdn.test/a',{},context)).text();
  assert.equal(http_cache.entries.size,1);
  new SiteDataStore().clear('site.test');assert.equal(http_cache.entries.size,0);
});

test('Concurrent incomplete responses cannot exceed the cache collection budget',async()=>{
  const {cache,response}=fixture({maxBytes:4,maxEntryBytes:4});const controllers=[];
  const transport=async()=>response(new ReadableStream({start(controller){controllers.push(controller);controller.enqueue(new Uint8Array([1,2,3]));}}));
  const first=await cache.fetch(transport,'https://site.test/a',{},context);
  const second=await cache.fetch(transport,'https://site.test/b',{},context);
  await new Promise(resolve=>setTimeout(resolve,0));assert.ok(cache.pendingBytes<=4);
  for(const controller of controllers)controller.close();
  assert.equal((await first.arrayBuffer()).byteLength,3);assert.equal((await second.arrayBuffer()).byteLength,3);
  assert.equal(cache.pendingBytes,0);assert.equal(cache.pendingWrites.size,0);assert.equal(cache.bytes,3);
});

test('Unsafe writes invalidate only matching pending representations',async()=>{
  const {cache,response}=fixture();const controllers=[];
  const transport=async(url,options)=>options.method==='POST'?response(null,{},204):response(new ReadableStream({start(controller){controllers.push(controller);}}));
  const first=await cache.fetch(transport,'https://site.test/a',{},context),second=await cache.fetch(transport,'https://site.test/b',{},context);
  await cache.fetch(transport,'https://site.test/a',{method:'POST'},context);
  for(const controller of controllers){controller.enqueue(new Uint8Array([1]));controller.close();}
  await first.text();await second.text();
  assert.deepEqual([...cache.entries.values()].map(entry=>entry.url),['https://site.test/b']);assert.equal(cache.pendingWrites.size,0);
});

test('Ambiguous max-age values and case-insensitive Pragma requests require validation',async()=>{
  for(const control of ['max-age=0, max-age=600','max-age=broken']){
    const {cache,response}=fixture();let calls=0;
    const transport=async()=>{calls++;return response('body',{'Cache-Control':control,'Last-Modified':'Wed, 01 Jan 2025 00:00:00 GMT'});};
    for(let count=0;count<2;count++)await (await cache.fetch(transport,'https://site.test/a',{},context)).text();
    assert.equal(calls,2,control);
  }
  const {fetch,calls}=fixture();await (await fetch('https://site.test/a')).text();
  await (await fetch('https://site.test/a',{headers:{Pragma:'No-Cache'}})).text();assert.equal(calls.length,2);
});

test('A new no-store response removes a previously stored matching representation',async()=>{
  const {cache,response}=fixture();let calls=0;
  const transport=async()=>response('body-'+ ++calls,{'Cache-Control':calls===2?'no-store':'max-age=60'});
  await (await cache.fetch(transport,'https://site.test/a',{},context)).text();
  await (await cache.fetch(transport,'https://site.test/a',{cache:'no-cache'},context)).text();
  assert.equal(cache.entries.size,0);
  assert.equal(await (await cache.fetch(transport,'https://site.test/a',{cache:'force-cache'},context)).text(),'body-3');
});
