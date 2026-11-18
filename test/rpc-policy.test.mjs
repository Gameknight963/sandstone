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
  assert.deepEqual(call('frame_unregister',['first']),['first']);
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
