import test from 'node:test';
import assert from 'node:assert/strict';
import {worker_script_frame,worker_script_url,frame_cross_site} from '../src/host/frame_context.mjs';

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

test('Blob worker site checks use inherited origins and retain cross-site ancestor restrictions',()=>{
  const root={id:'root',root_id:'root',url:new URL('https://site.test/page')};
  const worker={id:'worker',root_id:'root',parent_id:'root',origin:'https://site.test',broadcast_origin:'https://site.test'};
  const frames={root};
  for(const url of ['blob:null/id','blob:https://site.test/id'])assert.equal(frame_cross_site({...worker,url:new URL(url)},frames),false);
  assert.equal(frame_cross_site({...worker,url:new URL('blob:https://site.test/id'),retained_cross_site:true},frames),true);
  const cross={...worker,id:'cross',origin:'https://other.test',url:new URL('https://other.test/frame')};frames.cross=cross;
  assert.equal(frame_cross_site({...worker,parent_id:'cross',url:new URL('blob:https://site.test/id')},frames),true);
  assert.equal(frame_cross_site({...worker,url:new URL('data:text/javascript,0'),origin:'null',broadcast_origin:'opaque:worker'},frames),true);
});
