import test from 'node:test';
import assert from 'node:assert/strict';
import {worker_script_frame,worker_script_url} from '../src/host/frame_context.mjs';

test('Worker script contexts require a current owner and retain its origin boundary',()=>{
  const parent={origin:'https://site.test',document_context:'current'},worker={worker:true,parent_id:'parent',parent_context:'current',origin:'https://site.test',url:new URL('https://site.test/worker.js')};
  const frames={parent,worker};assert.equal(worker_script_frame(frames,'parent','worker'),worker);
  for(const patch of [{worker:false},{parent_id:'other'},{parent_context:'retired'},{origin:'https://other.test'},{url:new URL('https://other.test/worker.js'),origin:'https://other.test'}]){
    frames.worker={...worker,...patch};assert.throws(()=>worker_script_frame(frames,'parent','worker'),{name:'SecurityError'});
  }
  frames.worker={...worker,url:new URL('data:text/javascript,postMessage(1)'),origin:'null'};assert.equal(worker_script_frame(frames,'parent','worker'),frames.worker);
  frames.worker={...worker,url:new URL('blob:null/worker')};assert.equal(worker_script_frame(frames,'parent','worker'),frames.worker);
  assert.throws(()=>worker_script_frame(frames,'unknown','worker'),{name:'SecurityError'});
});

test('Worker registration accepts local sources but cannot delegate another HTTP or blob origin',()=>{
  for(const url of ['https://site.test/worker.js','blob:https://site.test/id','blob:null/id','data:text/javascript,postMessage(1)'])assert.equal(worker_script_url(url,'https://site.test').href,url);
  for(const url of ['https://other.test/worker.js','blob:https://other.test/id','file:///private/worker.js','javascript:postMessage(1)'])assert.throws(()=>worker_script_url(url,'https://site.test'),{name:'SecurityError'});
  assert.throws(()=>worker_script_url('https://site.test/worker.js','null'),{name:'SecurityError'});
});
