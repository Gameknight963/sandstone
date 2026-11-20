import test from 'node:test';
import assert from 'node:assert/strict';
import {create_xhr_class} from '../src/frame/xhr.mjs';

const create = fetch => create_xhr_class({fetch,base:()=> 'https://site.test/base/page'});
const ended = xhr => new Promise(resolve=>xhr.addEventListener('loadend',resolve,{once:true}));
const delay = milliseconds => new Promise(resolve=>setTimeout(resolve,milliseconds));

test('Isolated worker synchronous XHR returns completed bytes with native synchronous events and errors',()=>{
  let fail=false;
  const XHR=create_xhr_class({isWorker:true,base:()=> 'https://app.test/',fetch(){throw new Error('Must use synchronous transport');},sync_fetch(url,options,timeout){if(fail)throw new DOMException('Timed out','TimeoutError');assert.equal(timeout,20);assert.equal(url,'https://app.test/text');return {status:200,statusText:'OK',url,headers:[['content-type','text/plain;charset=utf-8'],['content-length','4']],bytes:new TextEncoder().encode('a€')};}});
  const xhr=new XHR(),events=[];for(const type of ['readystatechange','loadstart','progress','load','loadend'])xhr.addEventListener(type,event=>events.push([type,xhr.readyState,event.loaded]));
  xhr.open('GET','text',false);xhr.timeout=20;xhr.send();assert.equal(xhr.responseText,'a€');assert.equal(xhr.status,200);assert.deepEqual(events,[['readystatechange',1,undefined],['readystatechange',4,undefined],['load',4,4],['loadend',4,4]]);
  events.length=0;xhr.open('GET','text',false);fail=true;assert.throws(()=>xhr.send(),{name:'TimeoutError'});assert.equal(xhr.readyState,4);assert.equal(xhr.status,0);assert.equal(xhr.responseText,'');assert.deepEqual(events,[['readystatechange',1,undefined]]);
});

test('XHR snapshots a blank document referrer before body serialization completes', async () => {
  let referrer='',received;
  const XHR=create_xhr_class({base:()=> 'https://site.test/base/',client_referrer:()=>referrer,fetch:async(url,options)=>{
    received=options.referrer;return new Response('done');
  }});
  const xhr=new XHR();xhr.open('POST','echo');const done=ended(xhr);
  xhr.send(new Blob(['body']));referrer=undefined;
  await done;
  assert.equal(xhr.status,200);assert.equal(received,'');
});

test('XHR JSON responses, headers and event handler ordering preserve identity', async () => {
  let request;
  const XHR=create(async (url,options)=>{
    request={url,options};
    return new Response('{"value":42}',{status:404,statusText:'Not Found',headers:{'Content-Type':'application/json','Set-Cookie':'hidden=yes'}});
  });
  const xhr=new XHR(), events=[];
  const upload=xhr.upload;
  xhr.onreadystatechange=()=>events.push(xhr.readyState);
  xhr.open('get','../json#hash');
  assert.equal(xhr.upload,upload);
  xhr.setRequestHeader('X-Test','one'); xhr.setRequestHeader('x-test','two');
  xhr.setRequestHeader('Cookie','injected=yes');
  xhr.responseType='json';
  xhr.addEventListener('load',()=>events.push('first'));
  xhr.onload=()=>events.push('discarded');
  xhr.addEventListener('load',()=>events.push('last'));
  xhr.onload=function(event){assert.equal(this,xhr);assert.equal(event.target,xhr);events.push('handler');};
  const done=ended(xhr); xhr.send(); await done;
  assert.equal(xhr.status,404);
  assert.equal(xhr.statusText,'Not Found');
  assert.deepEqual(xhr.response,{value:42});
  assert.equal(xhr.response,xhr.response);
  assert.throws(()=>xhr.responseText,{name:'InvalidStateError'});
  assert.equal(xhr.responseURL,'https://site.test/json');
  assert.equal(xhr.getResponseHeader('set-cookie'),null);
  assert.doesNotMatch(xhr.getAllResponseHeaders(),/set-cookie/);
  assert.equal(request.options.headers['x-test'],'one, two');
  assert.equal(request.options.headers.cookie,undefined);
  assert.equal(request.options.credentials,'same-origin');
  assert.equal(XHR.DONE,4);assert.equal(xhr.DONE,4);
  assert.deepEqual(events,[1,2,3,4,'first','handler','last']);
  xhr.open('GET','again'); assert.equal(xhr.upload,upload);assert.equal(xhr.response,null);
});

test('XHR exposes partial text, byte progress and final decoding across split UTF-8 sequences', async () => {
  let release;
  const second=new Promise(resolve=>release=resolve);
  const XHR=create(async ()=>new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(new Uint8Array([65,0xe2]));
      await second;
      controller.enqueue(new Uint8Array([0x82,0xac,66]));controller.close();
    }
  }),{headers:{'content-length':'5','content-type':'text/plain;charset=utf-8'}}));
  const xhr=new XHR(),states=[],progress=[];
  xhr.onreadystatechange=()=>{states.push(xhr.readyState);if(xhr.readyState===3) assert.ok(xhr.responseText.startsWith('A'));};
  xhr.onprogress=event=>progress.push({loaded:event.loaded,total:event.total,lengthComputable:event.lengthComputable});
  xhr.open('GET','stream'); const done=ended(xhr);xhr.send();
  while(xhr.readyState!==3) await delay(1);
  assert.equal(xhr.status,200);release();await done;
  assert.equal(xhr.responseText,'A€B');
  assert.equal(xhr.response,'A€B');
  assert.deepEqual(states,[1,2,3,3,4]);
  assert.deepEqual(progress.at(-1),{loaded:5,total:5,lengthComputable:true});
});

test('XHR serializes FormData and typed-array subviews and keeps upload events separate', async () => {
  const requests=[];
  const XHR=create(async (url,options)=>{requests.push(options);return new Response('ok');});
  const xhr=new XHR(),events=[];
  for(const type of ['loadstart','progress','load','loadend']) {
    xhr.upload.addEventListener(type,event=>events.push({type,loaded:event.loaded}));
  }
  xhr.open('POST','upload');xhr.withCredentials=true;
  const data=new FormData();data.append('name','value');data.append('file',new Blob(['bytes']),'a.txt');
  let done=ended(xhr);xhr.send(data);await done;
  assert.match(requests[0].headers['content-type'],/^multipart\/form-data; boundary=/);
  assert.match(new TextDecoder().decode(requests[0].body),/filename="a.txt"/);
  assert.equal(requests[0].credentials,'include');
  assert.deepEqual(events.map(event=>event.type),['loadstart','progress','load','loadend']);
  assert.equal(events.at(-1).loaded,requests[0].body.byteLength);
  xhr.open('POST','bytes');done=ended(xhr);xhr.send(new Uint8Array([1,2,3,4]).subarray(1,3));await done;
  assert.deepEqual([...new Uint8Array(requests[1].body)],[2,3]);
});

test('XHR abort and timeout cancel the transport and cannot be overwritten by a late result', async () => {
  const pending=[];
  const XHR=create((url,options)=>new Promise(resolve=>pending.push({resolve,signal:options.signal})));
  const xhr=new XHR(),events=[];
  for(const type of ['abort','timeout','error','load','loadend']) xhr.addEventListener(type,()=>events.push([type,xhr.readyState,xhr.status]));
  xhr.open('GET','abort');xhr.send();while(!pending.length) await delay(1);
  xhr.abort();
  assert.equal(xhr.readyState,0);assert.equal(pending[0].signal.aborted,true);
  assert.deepEqual(events,[['abort',4,0],['loadend',4,0]]);
  pending[0].resolve(new Response('too late'));await delay(5);assert.equal(xhr.readyState,0);
  events.length=0;xhr.open('GET','timeout');xhr.timeout=10;
  const done=ended(xhr);xhr.send();await done;
  assert.equal(pending[1].signal.aborted,true);
  assert.deepEqual(events,[['timeout',4,0],['loadend',4,0]]);
  assert.equal(xhr.responseText,'');assert.equal(xhr.responseURL,'');
  pending[1].resolve(new Response('also late'));await delay(5);
  assert.equal(xhr.status,0);assert.equal(xhr.readyState,4);
});

test('XHR handles network errors and reused requests without stale responses or timers', async () => {
  let release;
  const XHR=create(url=>url.endsWith('old') ? new Promise(resolve=>release=resolve) : url.endsWith('error') ? Promise.reject(new Error('offline')) : Promise.resolve(new Response('new')));
  const xhr=new XHR();xhr.open('GET','old');xhr.send();while(!release) await delay(1);
  xhr.open('GET','new');const done=ended(xhr);xhr.send();await done;
  release(new Response('old'));await delay(5);assert.equal(xhr.responseText,'new');
  const failures=[];xhr.onerror=()=>failures.push('error');xhr.open('GET','error');
  const failed=ended(xhr);xhr.send();await failed;
  assert.deepEqual(failures,['error']);assert.equal(xhr.readyState,4);assert.equal(xhr.status,0);
});

test('XHR validates API state, decodes overridden character sets and caches binary responses', async () => {
  const XHR=create(async ()=>new Response(new Uint8Array([0x63,0x61,0x66,0xe9]),{headers:{'content-type':'text/plain'}}));
  const xhr=new XHR();
  assert.throws(()=>xhr.send(),{name:'InvalidStateError'});
  assert.throws(()=>xhr.open('TRACE','/'),{name:'SecurityError'});
  assert.throws(()=>xhr.open('GET','http://['),{name:'SyntaxError'});
  assert.throws(()=>xhr.open('GET','/',false),{name:'InvalidAccessError'});
  xhr.open('GET','encoding');xhr.overrideMimeType('text/plain; charset=windows-1252');
  let done=ended(xhr);xhr.send();assert.throws(()=>xhr.send(),{name:'InvalidStateError'});await done;
  assert.equal(xhr.responseText,'café');
  xhr.open('GET','binary');xhr.responseType='arraybuffer';done=ended(xhr);xhr.send();await done;
  assert.deepEqual([...new Uint8Array(xhr.response)],[0x63,0x61,0x66,0xe9]);assert.equal(xhr.response,xhr.response);
  xhr.open('GET','blob');xhr.responseType='blob';done=ended(xhr);xhr.send();await done;
  assert.equal(xhr.response.type,'text/plain');assert.equal(xhr.response,xhr.response);
});

test('XHR timeouts can be disabled or changed in flight without overflowing browser timers', async () => {
  const XHR=create(async ()=>{await delay(15);return new Response('ok');});
  const xhr=new XHR();
  for(const timeout of [0xffffffff,0]) {
    xhr.open('GET','timer');xhr.timeout=timeout||5;
    const done=ended(xhr);xhr.send();if(!timeout)xhr.timeout=0;await done;
    assert.equal(xhr.status,200);assert.equal(xhr.responseText,'ok');
  }
  xhr.open('GET','timer');xhr.timeout=1000;
  const done=ended(xhr);xhr.send();xhr.timeout=1;await done;
  assert.equal(xhr.status,0);assert.equal(xhr.readyState,4);
});
