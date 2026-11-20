import test from 'node:test';
import assert from 'node:assert/strict';
import {RPCSourcePolicy} from '../src/host/rpc_policy.mjs';

function fixture(){
  const frames={root:{id:'root',root_id:'root',document_context:'root-document'}},contexts=new Map([['root-document',{frame:'root'}]]);
  const policy=new RPCSourcePolicy({root:'root',frames:()=>frames,contexts:()=>contexts}),port={};
  policy.bind_root(port,'root-document');
  const call=(procedure,args,source=port)=>policy.authorize({type:'procedure',procedure,arguments:args},source);
  const child=(id,parent='root',parent_context='root-document')=>{
    frames[id]={id,root_id:'root',parent_id:parent,parent_context,document_context:id+'-document'};
    contexts.set(id+'-document',{frame:id});policy.document(id,id+'-document',parent_context);
  };
  return {frames,contexts,policy,port,call,child};
}

test('Service worker owner commands require the active owner port and cannot be supplied by its worker',()=>{
  const {call,frames,policy,port,child,contexts}=fixture(),worker={};
  const args=['root','skipWaiting',[]];
  assert.throws(()=>call('service_worker_command',args),{name:'SecurityError'});
  frames.root.service_worker_host=true;assert.deepEqual(call('service_worker_command',args),args);
  policy.attach(port,worker,'worker');child('worker');frames.worker.worker=true;
  assert.throws(()=>call('service_worker_command',args,worker),{name:'SecurityError'});
  assert.throws(()=>call('service_worker_command',['worker','skipWaiting',[]],worker),{name:'SecurityError'});
  contexts.get('root-document').retired=true;assert.throws(()=>call('service_worker_command',args),{name:'SecurityError'});
});

test('Only an active parent may prefetch scripts for its own worker while general child fetches remain restricted',()=>{
  const {frames,call,child,policy,port,contexts}=fixture();child('worker');frames.worker.worker=true;child('iframe');
  const args=['root','worker','request','https://site.test/script.js',{}];assert.deepEqual(call('fetch_worker_script',args),args);
  for(const args of [['root','iframe','request','https://site.test/script.js',{}],['other','worker','request','https://site.test/script.js',{}],['root','unknown','request','https://site.test/script.js',{}]])assert.throws(()=>call('fetch_worker_script',args),{name:'SecurityError'});
  assert.throws(()=>call('fetch',['worker','request','https://site.test/script.js',{mode:'no-cors'}]),{name:'SecurityError'});
  const sibling={};policy.attach(port,sibling,'iframe');assert.throws(()=>call('fetch_worker_script',['iframe','worker','request','https://site.test/script.js',{}],sibling),{name:'SecurityError'});
  contexts.set('next-root',{frame:'root'});frames.root.document_context='next-root';policy.bind_root(port,'next-root');assert.throws(()=>call('fetch_worker_script',args),{name:'SecurityError'});
});

test('Synchronous worker fetches require the active owning document and cannot borrow sibling or iframe identities',()=>{
  const {frames,call,child,policy,port,contexts}=fixture();child('worker');frames.worker.worker=true;child('iframe');
  const args=['root','worker','request','https://site.test/resource',{method:'POST'}];assert.deepEqual(call('fetch_worker_request',args),args);
  for(const args of [['root','iframe','request','https://site.test/',{}],['other','worker','request','https://site.test/',{}]])assert.throws(()=>call('fetch_worker_request',args),{name:'SecurityError'});
  const sibling={};policy.attach(port,sibling,'iframe');assert.throws(()=>call('fetch_worker_request',['iframe','worker','request','https://site.test/',{}],sibling),{name:'SecurityError'});
  contexts.get('root-document').retired=true;assert.throws(()=>call('fetch_worker_request',args),{name:'SecurityError'});
});

test('RPC ports bind frame IDs and document capabilities independently of supplied arguments',()=>{
  const {call,port,policy,child}=fixture();const source={};
  policy.attach(port,source,'child');child('child');
  assert.deepEqual(call('idb_databases',['child'],source),['child']);
  for(const [procedure,args] of [['idb_databases',['root']],['crypto',['root']],['cache_command',['root']],['ws_new',['root']],['history_go',['root']],['storage_ready',['child','root-document']],['beacon',['root-document']],['local_storage',['child',[],{context:'root-document'}]]]){
    assert.throws(()=>call(procedure,args,source),{name:'SecurityError'},procedure);
  }
  assert.throws(()=>call('idb_databases',['child'],{}),{name:'SecurityError'});
  assert.throws(()=>call('eval',[],source),{name:'SecurityError'});
  assert.throws(()=>policy.authorize({type:'notification',procedure:'cookie_set',arguments:['child','stolen']},source),{name:'SecurityError'});
});

test('Child registration and channel attachment cannot replace unrelated or ancestor sources',()=>{
  const {policy,port,call,child}=fixture(),first={},second={};
  assert.throws(()=>policy.attach(port,undefined,'first'),{name:'SecurityError'});
  policy.attach(port,first,'first');child('first');policy.attach(port,second,'second');child('second');
  assert.throws(()=>policy.attach(port,{},'first'),{name:'SecurityError'});
  assert.throws(()=>policy.attach(first,{},'root'),{name:'SecurityError'});
  assert.throws(()=>policy.attach(first,{},'second'),{name:'SecurityError'});
  assert.throws(()=>call('frame_unregister',['second'],first),{name:'SecurityError'});
  policy.attach(first,{},'pending');
  assert.throws(()=>call('frame_register',['second','pending','https://site.test'],second),{name:'SecurityError'});
  assert.deepEqual(call('frame_register',['first','pending','https://site.test'],first),['first','pending','https://site.test']);
  assert.deepEqual(call('frame_unregister',['first']),['first',{source_frame:'root',source_document:'root-document'}]);
  assert.deepEqual(call('frame_unregister',['pending',{source_frame:'second',source_document:'forged'}],first),['pending',{source_frame:'first',source_document:'first-document'}]);
  assert.throws(()=>call('service_worker_open',['first','root-document',{}],first),{name:'SecurityError'});
  assert.throws(()=>call('service_worker_client',['root','root-document','list',[]],first),{name:'SecurityError'});
  assert.deepEqual(call('service_worker_client',['first','first-document','list',[]],first),['first','first-document','list',[]]);
});

test('Retired channels retain only their own storage and network document leases',()=>{
  const {policy,port,call,child,contexts,frames}=fixture(),old={},replacement={};
  policy.attach(port,old,'child');child('child');
  contexts.get('child-document').retired=true;policy.forget('child');
  delete frames.child;policy.attach(port,replacement,'child');
  frames.child={id:'child',root_id:'root',parent_id:'root',parent_context:'root-document',document_context:'new-document'};
  contexts.set('new-document',{frame:'child'});policy.document('child','new-document','root-document');
  for(const procedure of ['beacon','fetch_keepalive','fetch_keepalive_read'])assert.deepEqual(call(procedure,['child-document'],old),['child-document']);
  assert.deepEqual(call('cookie_set',['child','a=old','https://old.test/path'],old),['child','a=old','https://old.test/path','child-document']);
  assert.throws(()=>call('beacon',['new-document'],old),{name:'SecurityError'});
  assert.throws(()=>call('idb_databases',['child'],old),{name:'SecurityError'});
  assert.deepEqual(call('idb_databases',['child'],replacement),['child']);
});

test('Parent renderers may prepare owned child navigations without impersonating other frames',()=>{
  const {call,child,policy,port}=fixture(),nested={};child('child');policy.attach(port,nested,'child');
  assert.deepEqual(call('fetch',['child','request','https://site.test',{mode:'navigate'}]),['child','request','https://site.test',{mode:'navigate'}]);
  assert.deepEqual(call('fetch_read',['child','request']),['child','request']);
  assert.throws(()=>call('fetch',['child','request','https://site.test',{mode:'cors'}]),{name:'SecurityError'});
  assert.throws(()=>call('fetch',['root','request','https://site.test',{mode:'navigate'}],nested),{name:'SecurityError'});
});

test('Lock RPCs cannot query or acquire locks using another document capability',()=>{
  const {call,child,policy,port}=fixture(),nested={};policy.attach(port,nested,'child');child('child');
  for(const procedure of ['lock_open','lock_query']){
    assert.deepEqual(call(procedure,['root-document']),['root-document']);
    assert.throws(()=>call(procedure,['child-document']),{name:'SecurityError'});
    assert.throws(()=>call(procedure,['root-document'],nested),{name:'SecurityError'});
  }
});

test('Document-open URL updates require both the source frame and its current document token',()=>{
  const {call,child,policy,port}=fixture(),nested={};policy.attach(port,nested,'child');child('child');
  const snapshot={url:'https://site.test/written',cookie_url:'https://site.test/written'};
  assert.deepEqual(call('document_open',['child','child-document',snapshot],nested),['child','child-document',snapshot]);
  assert.throws(()=>call('document_open',['root','root-document',snapshot],nested),{name:'SecurityError'});
  assert.throws(()=>call('document_open',['child','root-document',snapshot],nested),{name:'SecurityError'});
  assert.throws(()=>call('document_open',['child','child-document',snapshot]),{name:'SecurityError'});
});

test('Retirement cancels only readiness requests carrying their original source capability',()=>{
  const {call,child,policy,port,contexts}=fixture(),nested={};policy.attach(port,nested,'child');child('child');
  contexts.get('child-document').retired=true;
  for(const procedure of ['storage_ready','cookies_ready']){
    assert.throws(()=>call(procedure,['child','child-document'],nested),{name:'AbortError'});
    for(const args of [['root','child-document'],['child','root-document'],['child','unknown']])assert.throws(()=>call(procedure,args,nested),{name:'SecurityError'});
    assert.throws(()=>call(procedure,['child','child-document'],{}),{name:'SecurityError'});
  }
  assert.throws(()=>call('idb_databases',['child'],nested),{name:'SecurityError'});
});

test('Cookie snapshots require the calling frame current document capability',()=>{
  const {call,child,policy,port}=fixture(),nested={};policy.attach(port,nested,'child');child('child');
  assert.deepEqual(call('cookies_ready',['child','child-document'],nested),['child','child-document']);
  assert.throws(()=>call('cookies_ready',['root','root-document'],nested),{name:'SecurityError'});
  assert.throws(()=>call('cookies_ready',['child','root-document'],nested),{name:'SecurityError'});
});
