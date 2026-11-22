import test from 'node:test';
import assert from 'node:assert/strict';
import {worker_urls} from '../src/host/worker_urls.mjs';

test('Retained worker URLs inherit HTTP and Blob creator origins while data scripts remain opaque',()=>{
  const url='https://worker.test/entry.js',creator_url='https://worker.test/page',top_url='https://top.test/page';
  assert.equal(worker_urls({url}).origin,'https://worker.test');
  assert.equal(worker_urls({url}).top.href,url);
  for(const url of ['blob:https://worker.test/id','blob:null/id']){
    const value=worker_urls({url,creator_url,top_url});
    assert.equal(value.script.href,url);assert.equal(value.origin,'https://worker.test');assert.equal(value.top.href,top_url);
  }
  const value=worker_urls({url:'data:text/javascript,onconnect=()=>{}',creator_url});
  assert.equal(value.origin,'null');assert.equal(value.top.href,creator_url);
});

test('Retained worker URLs require a trusted HTTP creator and reject foreign or executable URL schemes',()=>{
  const creator_url='https://worker.test/page';
  for(const url of ['https://other.test/entry.js','blob:https://other.test/id','file:///private/worker.js','javascript:postMessage(1)'])assert.throws(()=>worker_urls({url,creator_url}),{name:'SecurityError'});
  for(const url of ['blob:null/id','data:text/javascript,0'])assert.throws(()=>worker_urls({url}),{name:'TypeError'});
  for(const creator_url of ['data:text/html,0','file:///host.html','blob:https://worker.test/id'])assert.throws(()=>worker_urls({url:'blob:null/id',creator_url}),{name:'TypeError'});
  assert.throws(()=>worker_urls({url:'https://worker.test/entry.js',top_url:'data:text/html,0'}),{name:'TypeError'});
});
