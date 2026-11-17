import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeStorage} from '../src/frame/polyfill/storage.mjs';
import {StorageReplica} from '../src/storage_replica.mjs';

function fixture(entries=[]){
  const sent=[];let replica;
  const storage=new FakeStorage(entries,(_snapshot,change)=>replica.write(change));
  replica=new StorageReplica(entries,{replace:entries=>storage._replace_entries(entries),submit:change=>sent.push(change)});
  return {storage,replica,sent};
}
test('Peer updates preserve pending local writes until ordered host acknowledgements arrive',()=>{
  const {storage,replica,sent}=fixture([['key','initial']]);
  storage.setItem('key','mine');
  replica.update({type:'set',key:'key',value:'peer'});
  assert.equal(storage.getItem('key'),'mine');
  replica.update(sent[0],sent[0].id);
  assert.equal(storage.getItem('key'),'mine');assert.equal(replica.pending.length,0);
  replica.update({type:'set',key:'key',value:'later'});
  assert.equal(storage.getItem('key'),'later');assert.equal(sent.length,1);
});
test('Pending clears and later writes survive initial snapshots and earlier acknowledgements',()=>{
  const {storage,replica,sent}=fixture([['old','1']]);
  storage.clear();storage.setItem('new','2');
  replica.reset([['old','updated'],['peer','3']]);
  assert.deepEqual(storage._get_entries(),[['new','2']]);
  replica.update(sent[0],sent[0].id);assert.deepEqual(storage._get_entries(),[['new','2']]);
  replica.update(sent[1],sent[1].id);assert.deepEqual(storage._get_entries(),[['new','2']]);
  assert.equal(replica.pending.length,0);
});
