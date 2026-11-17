import test from 'node:test';
import assert from 'node:assert/strict';
import {navigation_request_context} from '../src/host/frame_context.mjs';

function fixture(){
  const entry={frame:'source',retired:true,context:{root_id:'root',url:'https://source.test/old',top_url:'https://top.test/',cross_site:true,broadcast_origin:'opaque:document'}};
  const contexts=new Map([['document',entry]]),snapshot={document:'document',frame:'source',url:'https://source.test/new?q=1#private',top_url:'https://forged.test/',cross_site:false,broadcast_origin:'https://forged.test'};
  return {entry,contexts,snapshot};
}
test('Accepted navigation retains an immutable original document context after retirement and expiry',()=>{
  const {entry,contexts,snapshot}=fixture();
  const context=navigation_request_context(contexts,snapshot,'root');
  assert.deepEqual(context,{root_id:'root',url:snapshot.url,top_url:'https://top.test/',cross_site:true,broadcast_origin:'opaque:document',navigation:true,nested:true});
  assert.equal(Object.isFrozen(context),true);
  entry.context.url='https://changed.test/';entry.context.top_url='https://changed.test/';contexts.clear();
  assert.equal(context.url,'https://source.test/new?q=1#private');assert.equal(context.top_url,'https://top.test/');
});
test('Navigation source validation rejects unknown documents, other roots, frame IDs and changed origins or credentials',()=>{
  const {contexts,snapshot}=fixture();
  for(const invalid of [{document:'unknown'},{frame:'other'},{url:'https://forged.test/'},{url:'https://user@source.test/'},{url:'invalid'}])assert.throws(()=>navigation_request_context(contexts,{...snapshot,...invalid},'root'),TypeError);
  assert.throws(()=>navigation_request_context(contexts,snapshot,'other-root'),TypeError);
});
