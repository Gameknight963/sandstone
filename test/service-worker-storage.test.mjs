import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {ServiceWorkerStorage} from '../src/service_worker/storage.mjs';

const origin='https://registered.test';
function state(id='one',site=origin){return {scope:site+'/',updateViaCache:'imports',active:{id,scriptURL:site+'/worker.js',type:'classic',source:'importScripts("https://cdn.test/runtime.js");',scripts:[{url:'https://cdn.test/runtime.js',source:'self.value=41;',headers:[['content-type','text/javascript']]}]}};}

test('Service worker registrations and complete active/waiting script snapshots survive reopening',async()=>{
  const factory=new IDBFactory(),first=new ServiceWorkerStorage(factory);
  const value=state();value.waiting={...value.active,id:'two',source:'self.updated=42;'};
  const ticket=await first.begin(origin);const saved=await first.commit(ticket,value,0);
  value.active.scripts[0].source='mutated';assert.equal(saved.state.active.scripts[0].source,'self.value=41;');first.close();
  const second=new ServiceWorkerStorage(factory);
  try{
    assert.equal(second.persistent,true);
    const restored=await second.read(origin,origin+'/#fragment');assert.equal(restored.revision,1);
    assert.equal(restored.state.active.scripts[0].source,'self.value=41;');assert.equal(restored.state.waiting.source,'self.updated=42;');
    restored.state.active.source='changed';assert.notEqual((await second.read(origin,origin+'/')).state.active.source,'changed');
    assert.equal((await second.list('https://other.test')).length,0);assert.deepEqual(await second.catalog(),[{origin,scope:origin+'/'}]);
  }finally{second.close();}
});
test('Service worker commits across connections reject stale revisions without replacing a newer graph',async()=>{
  const factory=new IDBFactory(),first=new ServiceWorkerStorage(factory),second=new ServiceWorkerStorage(factory);
  try{
    const [one,two]=await Promise.all([first.begin(origin),second.begin(origin)]);
    const results=await Promise.allSettled([first.commit(one,state('first'),0),second.commit(two,state('second'),0)]);
    assert.equal(results.filter(value=>value.status==='fulfilled').length,1);
    assert.equal(results.find(value=>value.status==='rejected').reason.name,'InvalidStateError');
    const saved=await first.read(origin,origin+'/');assert.equal(saved.revision,1);assert.ok(['first','second'].includes(saved.state.active.id));
    const replacement=state('third');await second.commit(two,replacement,1);assert.equal((await first.read(origin,origin+'/')).state.active.id,'third');
  }finally{first.close();second.close();}
});
test('Unregister tombstones stop older installs while allowing a subsequent explicit registration',async()=>{
  const storage=new ServiceWorkerStorage();
  try{
    const ticket=await storage.begin(origin);await storage.commit(ticket,state(),0);
    await storage.remove(ticket,origin+'/',1);assert.deepEqual(await storage.list(origin),[]);
    await assert.rejects(storage.commit(ticket,state('stale'),1),{name:'InvalidStateError'});
    const next=await storage.read(origin,origin+'/');assert.equal(next.state,null);assert.equal(next.revision,2);
    await storage.commit(await storage.begin(origin),state('new registration'),next.revision);assert.equal((await storage.list(origin))[0].state.active.id,'new registration');
  }finally{storage.close();}
});
test('Per-site clearing revokes pending installs even without a committed registration and remains origin isolated',async()=>{
  const factory=new IDBFactory(),storage=new ServiceWorkerStorage(factory),other=new ServiceWorkerStorage(factory);
  try{
    const ticket=await storage.begin(origin),pending=await other.begin('https://registered.test:8443'),foreign=await storage.begin('https://sub.registered.test');
    await storage.commit(ticket,state(),0);await storage.commit(foreign,state('foreign',foreign.origin),0);
    await other.clear('registered.test');
    assert.equal((await storage.list(origin)).length,0);assert.equal((await storage.list(foreign.origin)).length,1);
    await assert.rejects(storage.commit(ticket,state('resurrection'),0),{name:'AbortError'});
    await assert.rejects(other.commit(pending,state('pending',pending.origin),0),{name:'AbortError'});
    const fresh=await storage.begin(origin);await storage.commit(fresh,state('fresh'),0);assert.equal((await other.list(origin))[0].state.active.id,'fresh');
  }finally{storage.close();other.close();}
});
test('Denied native storage keeps a usable in-memory registration session',async()=>{
  const storage=new ServiceWorkerStorage({open(){throw new DOMException('Storage denied','SecurityError');}});
  try{
    const ticket=await storage.begin(origin);assert.equal(storage.persistent,false);await storage.commit(ticket,state(),0);
    assert.equal((await storage.list(origin)).length,1);await storage.clear('registered.test');assert.equal((await storage.list()).length,0);
  }finally{storage.close();}
});
test('A failed durable write preserves the previous registration and rejects with its original storage error',async()=>{
  const storage=new ServiceWorkerStorage(new IDBFactory());
  try{
    const ticket=await storage.begin(origin);await storage.commit(ticket,state(),0);
    const transaction=storage.db.transaction.bind(storage.db);
    storage.db.transaction=(...args)=>{
      const tx=transaction(...args),store=tx.objectStore('registrations'),put=store.put.bind(store);
      store.put=value=>{if(value.state?.active?.id==='failed')throw new DOMException('Disk quota','QuotaExceededError');return put(value);};
      return tx;
    };
    await assert.rejects(storage.commit(ticket,state('failed'),1),{name:'QuotaExceededError',message:'Disk quota'});
    assert.equal((await storage.read(origin,origin+'/')).state.active.id,'one');assert.equal((await storage.read(origin,origin+'/')).revision,1);
  }finally{storage.close();}
});
test('A browser unable to create the registration schema falls back without an uncaught upgrade error',async()=>{
  const factory=new IDBFactory(),storage=new ServiceWorkerStorage({open(...args){
    const request=factory.open(...args);
    request.addEventListener('upgradeneeded',()=>{request.result.createObjectStore=()=>{throw new DOMException('No disk space','QuotaExceededError');};});
    return request;
  }});
  try{const ticket=await storage.begin(origin);assert.equal(storage.persistent,false);await storage.commit(ticket,state(),0);assert.equal((await storage.list(origin)).length,1);}
  finally{storage.close();}
});
test('Invalid worker principals, partial installs and unclonable graphs never replace installed scripts',async()=>{
  const storage=new ServiceWorkerStorage();
  try{
    await assert.rejects(storage.begin('http://untrusted.test'),{name:'SecurityError'});
    const ticket=await storage.begin(origin);await storage.commit(ticket,state(),0);
    const invalid=state('invalid');invalid.waiting={...invalid.active,scriptURL:'https://foreign.test/worker.js'};
    await assert.rejects(storage.commit(ticket,invalid,1),{name:'SecurityError'});
    await assert.rejects(storage.commit(ticket,{...state(),installing:{}},1),TypeError);
    const unclonable=state();unclonable.active.callback=()=>{};await assert.rejects(storage.commit(ticket,unclonable,1),{name:'DataCloneError'});
    assert.equal((await storage.read(origin,origin+'/')).state.active.id,'one');assert.equal((await storage.read(origin,origin+'/')).revision,1);
  }finally{storage.close();}
});
