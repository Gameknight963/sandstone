import test from 'node:test';
import assert from 'node:assert/strict';
import {ServiceWorkerScripts} from '../src/service_worker/scripts.mjs';

test('Service worker script resources snapshot redirected URLs, policies and independent response bodies',async()=>{
  const scripts=new ServiceWorkerScripts(),url='https://site.test/runtime.js';let requests=0;
  const fetch=async()=>{
    requests++;const response=new Response('self.value=41;',{headers:{'content-type':'application/javascript','referrer-policy':'no-referrer'}});
    Object.defineProperties(response,{url:{value:'https://cdn.test/assets/runtime.js'},redirected:{value:true},request_cross_origin:{value:true}});return response;
  };
  const [first,second]=await Promise.all([scripts.fetch(url,{},'javascript',fetch),scripts.fetch(url,{},'javascript',fetch)]);
  assert.equal(requests,1);assert.equal(await first.text(),'self.value=41;');assert.equal(await second.text(),'self.value=41;');
  assert.equal(first.url,'https://cdn.test/assets/runtime.js');assert.equal(first.redirected,true);assert.equal(first.request_cross_origin,true);assert.equal(first.headers.get('referrer-policy'),'no-referrer');
  const snapshot=scripts.snapshot();snapshot[0].source='modified';assert.equal(scripts.snapshot()[0].source,'self.value=41;');
});
test('Restored service workers use installed resources without fetching and reject missing scripts',async()=>{
  const url='https://site.test/runtime.js',scripts=new ServiceWorkerScripts([{url,source:'self.saved=42;',headers:[['content-type','text/javascript']]}],{restoring:true});
  let requests=0;const fetch=async()=>{requests++;return new Response('network changed');};
  assert.equal(await(await scripts.fetch(url,{},'javascript',fetch)).text(),'self.saved=42;');
  await assert.rejects(scripts.fetch('https://site.test/new.js',{},'javascript',fetch),{name:'NetworkError'});assert.equal(requests,0);
});
test('Failed or invalid script responses never enter the installed resource map and retries remain possible',async()=>{
  const scripts=new ServiceWorkerScripts(),url='https://site.test/runtime.js';
  await assert.rejects(scripts.fetch(url,{},'javascript',async()=>new Response('missing',{status:404})),TypeError);
  await assert.rejects(scripts.fetch(url,{},'javascript',async()=>new Response('<html>',{headers:{'content-type':'text/html'}})),TypeError);
  assert.equal(scripts.snapshot().length,0);
  assert.equal(await(await scripts.fetch(url,{},'javascript',async()=>new Response('self.good=true;',{headers:{'content-type':'text/javascript'}}))).text(),'self.good=true;');
  assert.equal(scripts.snapshot().length,1);
});
test('Saved module MIME types remain checked, including JSON dependencies',async()=>{
  const url='https://site.test/data.json',scripts=new ServiceWorkerScripts([{url,source:'{"value":42}',headers:[['content-type','application/json']]}],{restoring:true});
  assert.deepEqual(await(await scripts.fetch(url,{},'json')).json(),{value:42});
  await assert.rejects(scripts.fetch(url,{},'javascript'),TypeError);
  const invalid=new ServiceWorkerScripts([{url,source:'self.fail=true;',status:404,headers:[['content-type','text/javascript']]}],{restoring:true});
  await assert.rejects(invalid.fetch(url,{},'javascript'),TypeError);
});
test('Script snapshots retain their native clone implementation after authored instrumentation',()=>{
  const original=globalThis.structuredClone;
  try{
    globalThis.structuredClone=()=>{throw new Error('Authored clone');};
    const scripts=new ServiceWorkerScripts([{url:'https://site.test/worker.js',source:'self.value=41;'}]);
    assert.equal(scripts.snapshot()[0].source,'self.value=41;');
  }finally{globalThis.structuredClone=original;}
});
test('Empty successful script responses retain their null-body status and delivered headers',async()=>{
  const scripts=new ServiceWorkerScripts([{url:'https://site.test/worker.js',source:'',status:204,headers:[['content-type','text/javascript'],['referrer-policy','origin']]}],{restoring:true});
  const response=await scripts.fetch('https://site.test/worker.js',{},'javascript');assert.equal(response.status,204);assert.equal(response.body,null);assert.equal(response.headers.get('referrer-policy'),'origin');
});
