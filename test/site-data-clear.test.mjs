import test from 'node:test';
import assert from 'node:assert/strict';
import {prepare_site_data_clear} from '../src/site_data_clear.mjs';

function fixture(){
  const frames={root:{root_id:'root',url:new URL('https://parent.test/page')},child:{root_id:'root',url:new URL('https://embedded.test/child')},other:{root_id:'other',url:new URL('https://embedded.test/page')}};
  const entry=(frame,url,extra={})=>({frame,context:{url,root_id:frames[frame]?.root_id||'root'},...extra});
  const contexts=new Map([['top',entry('root','https://parent.test/page')],['child',entry('child','https://embedded.test/child',{storage:{}})],['old',entry('removed','https://embedded.test/old',{retired:true,storage:{}})],['other',entry('other','https://embedded.test/page',{storage:{}})]]);
  return {frames,contexts,clear:(host,selection)=>prepare_site_data_clear(host,selection,'root',frames,contexts)};
}
test('Preparing a clear revokes selected data for active and retired embedded documents in the discarded view',()=>{
  const {contexts,clear}=fixture(),oldSource=contexts.get('old').storage;
  assert.equal(clear('embedded.test',{localStorage:true,indexedDB:true}),true);
  for(const key of ['child','old']){assert.deepEqual(contexts.get(key).cleared_storage,{localStorage:true,indexedDB:true});assert.equal(contexts.get(key).storage.cleared_local,true);}
  assert.equal(oldSource.cleared_local,true);assert.equal(contexts.get('top').cleared_storage,undefined);assert.equal(contexts.get('other').cleared_storage,undefined);
});
test('Non-cookie clears remain exact-host while parent-domain cookie clears include descendants',()=>{
  const {frames,contexts,clear}=fixture();frames.child.url=new URL('https://child.parent.test/page');contexts.get('child').context.url=frames.child.url.href;contexts.delete('old');
  assert.equal(clear('parent.test',{fileSystems:true}),true);assert.equal(contexts.get('child').cleared_storage,undefined);
  clear('parent.test',{cookies:true});assert.deepEqual(contexts.get('child').cleared_storage,{cookies:true});assert.equal(contexts.get('child').storage.cleared_local,undefined);
  assert.deepEqual(contexts.get('top').cleared_storage,{fileSystems:true,cookies:true});
});
test('Pending frames and inherited document URLs select the owner without changing unrelated views',()=>{
  const {frames,contexts,clear}=fixture();contexts.clear();frames.pending={root_id:'root',url:new URL('https://pending.test/page')};
  assert.equal(clear('pending.test',{cacheStorage:true}),true);assert.equal(clear('absent.test',{localStorage:true}),false);
  contexts.set('inherited',{frame:'child',context:{root_id:'root',url:'about:blank',cookie_url:'https://inherited.test/base/'},storage:{}});
  assert.equal(clear('inherited.test',{localStorage:true}),true);assert.equal(contexts.get('inherited').storage.cleared_local,true);
  contexts.set('replacement',{frame:'child',context:{root_id:'root',url:'https://inherited.test/base/'},storage:{}});assert.equal(contexts.get('replacement').cleared_storage,undefined);
});

test('Blob documents revoke their creator site storage even when their physical URLs are opaque',()=>{
  const {frames,contexts,clear}=fixture(),blob='blob:null/local-preview';
  frames.preview={root_id:'root',url:new URL(blob),origin:'https://embedded.test',cookie_url:blob};
  contexts.set('preview',{frame:'preview',context:{root_id:'root',url:'https://embedded.test/',cookie_url:blob},storage:{}});
  contexts.set('opaque',{frame:'removed',context:{root_id:'root',url:'blob:null/opaque-preview',broadcast_origin:'opaque:preview'},storage:{}});
  assert.equal(clear('embedded.test',{localStorage:true,indexedDB:true,fileSystems:true}),true);
  assert.deepEqual(contexts.get('preview').cleared_storage,{localStorage:true,indexedDB:true,fileSystems:true});
  assert.equal(contexts.get('preview').storage.cleared_local,true);
  assert.equal(contexts.get('opaque').cleared_storage,undefined);
  contexts.clear();assert.equal(clear('embedded.test',{cacheStorage:true}),true,'A pending Blob frame selects its owning view');
});
