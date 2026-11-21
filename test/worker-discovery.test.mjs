import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {MemoryLockManager} from '../src/locks/manager.mjs';
import {hold_lock,publish_backend,find_backend,watch_backend} from '../src/host/worker_discovery.mjs';

test('Concurrent backend discovery finds a publisher even before its lease grant has returned',async()=>{
  const locks=new MemoryLockManager(),key='discovery:'+crypto.randomUUID(),descriptor={url:'blob:https://host.test/private',name:'backend'};
  const publishing=publish_backend(key,descriptor,{locks}),finding=find_backend(key,{locks});let publication;
  try{publication=await publishing;assert.deepEqual(await finding,descriptor);}
  finally{publication?.close();}
  await setImmediate();assert.deepEqual(await locks.query(),{held:[],pending:[]});
});

test('A missing discovery reply waits for actual lease loss rather than guessing that a live backend died',async()=>{
  const locks=new MemoryLockManager(),key='discovery:'+crypto.randomUUID(),lease=await hold_lock(key+':live',{locks});
  let settled=false;const finding=find_backend(key,{locks}).then(value=>{settled=true;return value;});
  try{
    await setImmediate();await setImmediate();assert.equal(settled,false);
    lease.close();assert.equal(await finding,null);
  }finally{lease.close();}
  await setImmediate();assert.deepEqual(await locks.query(),{held:[],pending:[]});
});

test('A second publisher cannot replace an existing backend and lifetime watches are cancellable',async()=>{
  const locks=new MemoryLockManager(),key='discovery:'+crypto.randomUUID(),descriptor={identity:'first'};
  const publication=await publish_backend(key,descriptor,{locks});let called=0,stop;
  try{
    assert.equal(await publish_backend(key,{identity:'second'},{locks}),null);
    assert.deepEqual(await find_backend(key,{locks}),descriptor);
    stop=watch_backend(key,()=>called++,{locks});await setImmediate();stop();publication.close();
    await setImmediate();assert.equal(called,0);assert.deepEqual(await locks.query(),{held:[],pending:[]});
  }finally{stop?.();publication.close();}
});

test('Backend lifetime watches report native lease release and remove their lock requests',async()=>{
  const locks=new MemoryLockManager(),key='discovery:'+crypto.randomUUID(),lease=await hold_lock(key+':live',{locks});
  let finish;const ended=new Promise(resolve=>{finish=resolve;}),stop=watch_backend(key,finish,{locks});
  try{lease.close();assert.equal((await ended).name,'AbortError');}
  finally{stop();lease.close();}
  await setImmediate();assert.deepEqual(await locks.query(),{held:[],pending:[]});
});
