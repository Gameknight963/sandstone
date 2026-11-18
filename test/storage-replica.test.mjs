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

test('Shared views ignore duplicate and older port deliveries while acknowledging the correct writer',()=>{
  const {storage,replica,sent}=fixture([['key','initial']]);
  replica.write({type:'set',key:'key',value:'first',context:'one'});
  replica.write({type:'set',key:'key',value:'second',context:'two'});
  replica.update(sent[0],undefined,1);
  replica.update(sent[1],undefined,2);
  assert.equal(replica.pending.length,0);assert.equal(storage.getItem('key'),'second');
  replica.update(sent[0],sent[0].id,1);
  replica.reset([['key','initial']],0);
  assert.equal(storage.getItem('key'),'second');
  replica.update({type:'set',key:'key',value:'external',id:1,context:'other'},undefined,3);
  assert.equal(storage.getItem('key'),'external');
});

test('An older acknowledgement cannot overwrite a newer authoritative shared snapshot',()=>{
  const {storage,replica,sent}=fixture();
  replica.write({type:'set',key:'key',value:'mine',context:'one'});
  replica.reset([['key','newer']],5);
  assert.equal(storage.getItem('key'),'mine');
  replica.update(sent[0],sent[0].id,4);
  assert.equal(storage.getItem('key'),'newer');assert.equal(replica.pending.length,0);
});

test('Storage objects from inactive documents reject reads, enumeration and mutations without changing the area',()=>{
  let active=true,writes=0;
  const storage=new FakeStorage([['key','saved']],()=>writes++,()=>{if(!active)throw new DOMException('Inactive document','SecurityError');});
  active=false;
  for(const operation of [()=>storage.getItem('key'),()=>storage.setItem('key','bad'),()=>storage.length,()=>storage.key(0),()=>storage.removeItem('key'),()=>storage.clear(),()=>storage.named,()=>{storage.named='bad';},()=>Object.keys(storage),()=>('key' in storage)])assert.throws(operation,{name:'SecurityError'});
  assert.equal(writes,0);active=true;assert.equal(storage.getItem('key'),'saved');
});
