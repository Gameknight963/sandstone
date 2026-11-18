import test from 'node:test';
import assert from 'node:assert/strict';
import {StorageWriteOrder} from '../src/storage_order.mjs';

test('Storage writes from separate ports commit in their synchronous frame-group order',()=>{
  const order=new StorageWriteOrder(),result=[];
  order.accept(3,()=>result.push('clear'));
  order.accept(2,()=>result.push('child write'));
  assert.deepEqual(result,[]);
  order.accept(1,()=>result.push('parent write'));
  assert.deepEqual(result,['parent write','child write','clear']);
  order.accept(4,()=>result.push('final'));
  assert.equal(result.at(-1),'final');assert.equal(order.pending.size,0);
});

test('Storage ordering rejects duplicates, invalid sequences and unbounded gaps without replacing queued writes',()=>{
  const order=new StorageWriteOrder(),result=[];
  order.accept(2,()=>result.push('original'));
  for(const sequence of [2,0,-1,1.5,Infinity,NaN,'1',10002])assert.throws(()=>order.accept(sequence,()=>result.push('bad')),TypeError);
  order.accept(1,()=>result.push('first'));
  assert.deepEqual(result,['first','original']);
  assert.throws(()=>order.accept(1,()=>{}),TypeError);
});
