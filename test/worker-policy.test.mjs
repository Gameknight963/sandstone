import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkerRPCPolicy} from '../src/host/worker_policy.mjs';
import {frame_cross_site} from '../src/host/frame_context.mjs';

function fixture(){
  const frames={owner:{id:'owner',root_id:'owner',url:new URL('https://top.test/'),document_context:'owner-context'},worker:{id:'worker',root_id:'owner',parent_id:'owner',parent_context:'owner-context',worker:true,url:new URL('https://worker.test/script.js'),document_context:'worker-context'}};
  const contexts=new Map([['owner-context',{frame:'owner'}],['worker-context',{frame:'worker'}]]);
  const policy=new WorkerRPCPolicy({root:'owner',frames:()=>frames,contexts:()=>contexts}),authority={},port={};
  policy.bind_root(authority,'owner-context');policy.attach(authority,port,'worker');policy.document('worker','worker-context','owner-context');
  return {frames,contexts,policy,port,call:(procedure,args,source=port)=>policy.authorize({type:'procedure',procedure,arguments:args},source)};
}

test('Retained worker ports retain their own origin capability without document procedures',()=>{
  const {call}=fixture();
  for(const procedure of ['idb_command','cache_command','crypto','ws_new'])assert.deepEqual(call(procedure,['worker',{}]),['worker',{}]);
  assert.deepEqual(call('filesystem_command',['worker-context',{op:'root'}]),['worker-context',{op:'root'}]);
  for(const procedure of ['navigate','history_mutate','document_open','storage_ready','cookie_set','frame_register','frame_unregister','worker_sync_open','service_worker_open','download_request'])assert.throws(()=>call(procedure,['worker','worker-context']),{name:'SecurityError'});
  assert.throws(()=>call('idb_command',['owner',{}]),{name:'SecurityError'});
  assert.throws(()=>call('filesystem_command',['owner-context',{}]),{name:'SecurityError'});
  assert.throws(()=>call('crypto',['worker',{}],{}),{name:'SecurityError'});
});

test('Retained worker fetches cannot impersonate navigations or another request context',()=>{
  const {call,contexts}=fixture();
  assert.equal(call('fetch',['worker','request','https://worker.test/data',{mode:'cors'}])[0],'worker');
  for(const options of [{mode:'navigate'},{sandstone_navigation_target:'owner'},{sandstone_navigation_activation:true},{sandstone_worker_entry:'other'},{sandstone_request_context:'other-context'}])assert.throws(()=>call('fetch',['worker','request','https://worker.test/',options]),{name:'SecurityError'});
  assert.throws(()=>call('fetch',['worker','request','https://worker.test/',{},{}]),{name:'SecurityError'});
  contexts.get('worker-context').retired=true;
  assert.throws(()=>call('fetch',['worker','request','https://worker.test/',{}]),{name:'SecurityError'});
});

test('Retained worker contexts preserve cross-site ancestors after their renderer disappears',()=>{
  const {frames}=fixture();
  frames.owner.url=new URL('https://worker.test/');
  assert.equal(frame_cross_site(frames.worker,frames),false);
  frames.worker.retained_cross_site=true;
  assert.equal(frame_cross_site(frames.worker,frames),true);
});
