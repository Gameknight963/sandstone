import test from 'node:test';
import assert from 'node:assert/strict';
import {create_request_class} from '../src/frame/request.mjs';
import {serialize_request} from '../src/frame/polyfill/request.mjs';

test('Virtual Request resolves against a changing base and retains native request behavior',async()=>{
  let base='https://site.test/assets/';
  const Request=create_request_class(()=>base,()=> 'https://site.test/page');
  const controller=new AbortController();
  const request=new Request('api',{method:'POST',body:'payload',headers:{'X-Test':'yes'},signal:controller.signal,credentials:'include',referrer:'/chosen#fragment'});
  assert.equal(request.url,'https://site.test/assets/api');
  assert.equal(request.referrer,'https://site.test/chosen#fragment');
  assert.ok(request instanceof globalThis.Request);
  const clone=request.clone();assert.ok(clone instanceof Request);assert.equal(clone.referrer,request.referrer);
  assert.equal(await clone.text(),'payload');assert.equal(request.bodyUsed,false);
  const serialized=await serialize_request(request,{},base,'https://site.test/page');
  assert.equal(serialized.options.referrer,'https://site.test/chosen#fragment');
  assert.equal(serialized.options.headers['x-test'],'yes');
  assert.equal(new TextDecoder().decode(serialized.options.body),'payload');
  controller.abort();assert.equal(serialized.signal.aborted,true);
  base='https://cdn.test/new/';assert.equal(new Request('next').url,'https://cdn.test/new/next');
  assert.equal(new Request('/api',{referrer:'/private'}).referrer,'about:client');
  assert.equal(new Request('/api',{referrer:''}).referrer,'');
  assert.equal(new Request('/api',{referrer:'https://user:pass@site.test/chosen#fragment'}).referrer,'https://user:pass@site.test/chosen#fragment');
  const inherited=new Request('/api',Object.create({method:'POST',body:'inherited',referrer:''}));
  assert.equal(inherited.method,'POST');assert.equal(await inherited.text(),'inherited');assert.equal(inherited.referrer,'');
  assert.throws(()=>new Request('/api',1),TypeError);
  assert.throws(()=>new Request(),TypeError);
  assert.throws(()=>new Request('/api',{method:'GET',body:'invalid'}),TypeError);
});

test('Opaque Request sources never treat distinct null URL origins as same-origin',async()=>{
  const base='https://site.test/assets/',source='about:srcdoc';
  const Request=create_request_class(()=>base,()=>source);
  for(const referrer of ['/chosen#part','about:srcdoc#part','data:text/plain,value','https://site.test/chosen']){
    const request=new Request('api',{referrer});
    assert.equal(request.referrer,'about:client');
    assert.equal(request.clone().referrer,'about:client');
    assert.equal((await serialize_request('api',{referrer},base,source)).options.referrer,'about:client');
  }
  assert.equal(new Request('api',{referrer:''}).referrer,'');
  assert.equal((await serialize_request('api',{referrer:''},base,source)).options.referrer,'');
});
