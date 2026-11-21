import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {getEventListeners} from 'node:events';
import {PolicyProviders,create_policy_provider,serve_policy_channel} from '../src/host/policy_providers.mjs';
import {MemoryLockManager} from '../src/locks/manager.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function add(pool,handle,authority='persistent',getter=()=>authority){
  const channel=new MessageChannel(),owner=new AbortController(),server=serve_policy_channel(channel.port1,handle,{authority:getter});
  pool.add(channel.port2,{authority,signal:owner.signal});
  return {owner,close(){owner.abort();server.close();}};
}

test('A provider joining later settles waiting requests and releasing its lease removes every watch',async()=>{
  const locks=new MemoryLockManager(),pool=new PolicyProviders({locks});let provider;
  try{
    const pending=pool.request({op:'capture'});assert.equal(pool.waiters.size,1);
    provider=await create_policy_provider(message=>message.op,{locks,authority:()=>'persistent'});
    pool.add(provider.port,provider);assert.equal(await pending,'capture');
    const during=await locks.query();assert.equal(during.held.length,1);assert.equal(during.pending.length,1);
    provider.close();await setImmediate();pool.close();await setImmediate();
    assert.deepEqual(await locks.query(),{held:[],pending:[]});
  }finally{provider?.close();pool.close();}
});

test('Closing a provider retries an in-flight operation with its original captured payload',async()=>{
  const pool=new PolicyProviders(),started=deferred(),held=deferred();let received;
  const first=add(pool,async()=>{started.resolve();await held.promise;return 'late';});
  const second=add(pool,message=>{received=message;return 'replacement';});
  try{
    const message={op:'set',options:{cookieAuthority:'persistent',cookieWrite:{id:'same-operation'}},value:'original'};
    const pending=pool.request(message);await started.promise;message.value='mutated';first.owner.abort();
    assert.equal(await pending,'replacement');assert.equal(received.value,'original');assert.equal(received.options.cookieWrite.id,'same-operation');
    held.resolve();await setImmediate();assert.equal(pool.providers.size,1);
  }finally{held.resolve();first.close();second.close();pool.close();}
});

test('Operation errors do not retire a healthy provider or replay the operation elsewhere',async()=>{
  const pool=new PolicyProviders();let fallback=0;
  const first=add(pool,()=>{throw new TypeError('Invalid policy input');}),second=add(pool,()=>fallback++);
  try{
    await assert.rejects(pool.request({op:'header'}),{name:'TypeError',message:'Invalid policy input'});
    assert.equal(fallback,0);assert.equal(pool.providers.size,2);
  }finally{first.close();second.close();pool.close();}
});

test('Aborting a pending call removes its reply entry and cancels work at the provider',async()=>{
  const pool=new PolicyProviders(),started=deferred(),cancelled=deferred(),held=deferred(),controller=new AbortController();
  const provider=add(pool,async(message,{signal})=>{signal.addEventListener('abort',()=>cancelled.resolve(),{once:true});started.resolve();await held.promise;return 'late';});
  try{
    const pending=pool.request({op:'header'},{signal:controller.signal});await started.promise;
    const channel=[...pool.providers][0];assert.equal(channel.pending.size,1);
    controller.abort();await assert.rejects(pending,{name:'AbortError'});await cancelled.promise;
    assert.equal(channel.pending.size,0);assert.equal(getEventListeners(controller.signal,'abort').length,0);
    held.resolve();await setImmediate();assert.equal(channel.pending.size,0);
  }finally{held.resolve();provider.close();pool.close();}
});

test('Waiting without a provider supports cancellation and pool shutdown without retaining listeners',async()=>{
  const pool=new PolicyProviders(),controller=new AbortController();
  const aborted=pool.request({op:'capture'},{signal:controller.signal}),closed=pool.request({op:'capture'});
  controller.abort();await assert.rejects(aborted,{name:'AbortError'});pool.close();await assert.rejects(closed,{name:'InvalidStateError'});
  assert.equal(pool.waiters.size,0);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});

test('Memory cookie authorities cannot read or write through a different live host after handoff',async()=>{
  const pool=new PolicyProviders();let wrong=0;
  const first=add(pool,()=>wrong++,'memory-a'),second=add(pool,()=> 'correct','memory-b');
  try{
    const message={op:'header',options:{cookieAuthority:'memory-b'}};assert.equal(await pool.request(message),'correct');
    second.owner.abort();await assert.rejects(pool.request(message),{name:'InvalidStateError'});assert.equal(wrong,0);
  }finally{first.close();second.close();pool.close();}
});

test('A host switching to memory storage advertises its new authority before its next request',async()=>{
  const pool=new PolicyProviders();let authority='persistent';
  const provider=add(pool,()=>{authority='memory-fallback';return authority;},'persistent',()=>authority);
  try{
    assert.equal(await pool.request({op:'capture'}),'memory-fallback');
    assert.equal(await pool.request({op:'header',options:{cookieAuthority:'memory-fallback'}}),'memory-fallback');
    await assert.rejects(pool.request({op:'header',options:{cookieAuthority:'persistent'}}),{name:'InvalidStateError'});
  }finally{provider.close();pool.close();}
});

test('Clone errors remain operation failures and do not discard a usable channel',async()=>{
  const pool=new PolicyProviders(),provider=add(pool,message=>message.op==='bad-result'?()=>{}:'ok');
  try{
    await assert.rejects(pool.request({op:'header',invalid:()=>{}}),{name:'DataCloneError'});
    await assert.rejects(pool.request({op:'bad-result'}),{name:'DataCloneError'});
    assert.equal(await pool.request({op:'header'}),'ok');assert.equal(pool.providers.size,1);
  }finally{provider.close();pool.close();}
});

test('Owner lock release detects death without a port close notification',async()=>{
  const locks=new MemoryLockManager(),pool=new PolicyProviders({locks}),ready=deferred(),hold=deferred(),started=deferred(),pendingWork=deferred();
  const lease='sandstone.policy-provider.v1:unit-owner';
  const lifetime=locks.request(lease,{},async()=>{ready.resolve();await hold.promise;});await ready.promise;
  const ports=new MessageChannel(),server=serve_policy_channel(ports.port1,async()=>{started.resolve();await pendingWork.promise;return 'late';});
  pool.add(ports.port2,{lease,authority:'persistent'});const replacement=add(pool,()=> 'alive');
  try{
    const request=pool.request({op:'header',options:{cookieAuthority:'persistent'}});await started.promise;
    hold.resolve();await lifetime;assert.equal(await request,'alive');assert.equal(pool.providers.size,1);
  }finally{hold.resolve();pendingWork.resolve();server.close();replacement.close();pool.close();}
});

test('An authority change redispatches scoped operations without treating the host as dead',async()=>{
  for(const fail of [false,true]){
    const pool=new PolicyProviders();let authority='persistent';
    const first=add(pool,()=>{authority='memory';if(fail)throw new DOMException('Authority changed','InvalidStateError');return 'wrong session';},'persistent',()=>authority);
    const second=add(pool,()=> 'persistent session');
    try{
      assert.equal(await pool.request({op:'header',options:{cookieAuthority:'persistent'}}),'persistent session');
      assert.equal(pool.providers.size,2);
    }finally{first.close();second.close();pool.close();}
  }
});

test('A synchronous lease watch failure cannot leave an unwatched provider installed',()=>{
  const pool=new PolicyProviders({locks:{request(){throw new DOMException('Denied','SecurityError');}}}),ports=new MessageChannel(),owner=new AbortController();
  try{
    assert.throws(()=>pool.add(ports.port1,{lease:'sandstone.policy-provider.v1:unavailable',signal:owner.signal}),{name:'SecurityError'});
    assert.equal(pool.providers.size,0);assert.equal(getEventListeners(owner.signal,'abort').length,0);
  }finally{pool.close();ports.port1.close();ports.port2.close();}
});
