import test from 'node:test';
import assert from 'node:assert/strict';
import {fetch_with_cookies} from '../src/host/request.mjs';
import {expose_response,remember_response,response_metadata,consume_filtered_response,restore_filtered_response} from '../src/response_metadata.mjs';
import {CacheService} from '../src/cache/service.mjs';
import {create_cache_api} from '../src/cache/client.mjs';
import {create_request_class} from '../src/frame/request.mjs';

test('HTTP response tainting retains cross-origin redirects without hiding internal resource bodies',async()=>{
  const store={cookies:{getCookiesSync:()=>[]},setCookie(){}},context={url:'https://site.test/page'};
  for(const [mode,target,opaque,type] of [['cors','site.test',false,'basic'],['no-cors','site.test',false,'basic'],['cors','other.test',false,'cors'],['no-cors','other.test',false,'opaque'],['cors','site.test',true,'cors'],['no-cors','site.test',true,'opaque']]){
    const response=await fetch_with_cookies(async()=>new Response('resource'),store,'https://'+target+'/data',{mode},{...context,...(opaque?{broadcast_origin:'opaque:client'}:{})});
    assert.equal(response.type,type);assert.equal(response.status,200);assert.equal(await response.text(),'resource');
  }
  for(const [mode,type] of [['cors','cors'],['no-cors','opaque']]){
    let hop=0;const response=await fetch_with_cookies(async()=>++hop===1?new Response(null,{status:302,headers:{location:'https://other.test/middle'}}):hop===2?new Response(null,{status:302,headers:{location:'https://site.test/final'}}):new Response('body'),store,'https://site.test/start',{mode},context);
    assert.equal(response.type,type);assert.equal(response.redirected,true);assert.equal(response.url,'https://site.test/final');assert.equal(await response.text(),'body');
  }
});

function raw(type='cors',expose='x-visible'){
  return remember_response(new Response('private body',{headers:{'content-type':'text/plain','x-visible':'yes','x-hidden':'secret','access-control-expose-headers':expose,'set-cookie':'private=yes'}}),{type,url:'https://other.test/data#fragment',redirected:true});
}
test('CORS exposure handles safelisted names, explicit names, credentials and immutable cloned headers',async()=>{
  for(const [expose,credentials,visible] of [['x-visible','include',['content-type','x-visible']],['*','omit',['access-control-expose-headers','content-type','x-hidden','x-visible']],['*','include',['content-type']],['x-visible, invalid name','omit',['content-type']]]){
    const response=expose_response(raw('cors',expose),credentials),copy=Response.prototype.clone.call(response);
    assert.equal(response.type,'cors');assert.equal(response.url,'https://other.test/data');assert.deepEqual([...response.headers.keys()],visible);assert.deepEqual([...copy.headers.keys()],visible);
    for(const headers of [response.headers,copy.headers])for(const [name,args] of [['set',['x','y']],['append',['x','y']],['delete',['x']]])assert.throws(()=>Headers.prototype[name].apply(headers,args),TypeError);
    assert.equal(await response.text(),'private body');assert.equal(await copy.text(),'private body');
    assert.equal(response_metadata(copy).internal_response.headers.some(([name])=>name==='x-hidden'),true);
  }
});

test('Opaque responses retain a private cached body while fetch and cache header guards differ',async()=>{
  const response=expose_response(raw('opaque'),'include'),copy=response.clone();
  assert.equal(response.type,'opaque');assert.equal(response.url,'');assert.equal(response.redirected,false);assert.equal(response.status,0);assert.equal(response.body,null);assert.equal(await response.text(),'');assert.equal(response.bodyUsed,false);
  assert.deepEqual([...response.headers],[]);assert.throws(()=>response.headers.set('x','y'),TypeError);
  const body=await consume_filtered_response(response),metadata=response_metadata(response);assert.equal(response.bodyUsed,true);assert.equal(await body.text(),'private body');assert.equal(await(await consume_filtered_response(copy)).text(),'private body');
  const restored=restore_filtered_response(metadata,body);restored.headers.set('x-cache','visible');const clone=Response.prototype.clone.call(restored);
  assert.deepEqual([...clone.headers],[['x-cache','visible']]);clone.headers.set('x-clone','yes');assert.equal(restored.headers.has('x-clone'),false);assert.equal(await clone.text(),'');
});

test('A cached CORS response retains its original wildcard exposure across a different credentials mode',async()=>{
  const original=expose_response(raw('cors','*'),'omit'),metadata=response_metadata(original);
  const internal=metadata.internal_response,restored=remember_response(new Response(await original.blob(),{status:internal.status,headers:internal.headers}),internal);
  const exposed=expose_response(restored,'include');assert.equal(exposed.headers.get('x-hidden'),'secret');assert.equal(exposed.headers.get('set-cookie'),null);assert.equal(await exposed.text(),'private body');
});

test('CORS filtering never passes hidden header pairs to authored array helpers',async()=>{
  const response=raw(),map=Array.prototype.map,filter=Array.prototype.filter,leaked=[];let exposed;
  const wrapper=method=>function(callback,receiver){for(let index=0;index<this.length;index++)if(Array.isArray(this[index])&&this[index][1]==='secret')leaked.push(this[index]);return Reflect.apply(method,this,[callback,receiver]);};
  try{Array.prototype.map=wrapper(map);Array.prototype.filter=wrapper(filter);exposed=expose_response(response,'include');}
  finally{Array.prototype.map=map;Array.prototype.filter=filter;}
  assert.deepEqual(leaked,[]);assert.equal(exposed.headers.has('x-hidden'),false);assert.equal(await exposed.text(),'private body');
});

test('Filtered cache headers remain mutable and clone independently while cache writes retain the internal response',async()=>{
  const service=new CacheService(),origin='https://site.test';
  const api=create_cache_api({command:command=>service.command('one',origin,command),Request:create_request_class(()=>origin+'/page')});
  const cache=await api.caches.open('filtered');
  for(const type of ['cors','opaque']){
    await cache.put('/'+type,expose_response(raw(type,'*'),'omit'));
    const response=await cache.match('/'+type);response.headers.set('x-added','new');response.headers.set('x-visible','changed');response.headers.delete('x-hidden');
    const copy=response.clone(),borrowed=Response.prototype.clone.call(response);
    for(const value of [copy,borrowed]){assert.equal(value.headers.get('x-added'),'new');assert.equal(value.headers.get('x-visible'),'changed');assert.equal(value.headers.has('x-hidden'),false);}
    copy.headers.set('x-copy','yes');assert.equal(response.headers.has('x-copy'),false);
    await cache.put('/again-'+type,borrowed);const restored=await cache.match('/again-'+type);
    assert.equal(restored.headers.has('x-added'),false);assert.equal(restored.headers.get('x-visible'),type==='opaque'?null:'yes');assert.equal(restored.headers.get('x-hidden'),type==='opaque'?null:'secret');
    if(type==='opaque')assert.equal(await(await consume_filtered_response(restored)).text(),'private body');else assert.equal(await restored.text(),'private body');
  }
});
