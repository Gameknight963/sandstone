import test from 'node:test';import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {SharedWorkerRegistry} from '../src/shared_worker/registry.mjs';
import {shared_worker_options} from '../src/shared_worker/options.mjs';

const profile=(options={})=>({storage_key:'top.test|worker.test',url:'https://worker.test/script.js',secure_context:true,options});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const clear=registry=>{for(const id of [...registry.ids.keys()])registry.close(id);};

test('Shared worker options preserve the legacy name and inherited dictionary conversion order',()=>{
  assert.equal(shared_worker_options('named').name,'named');assert.equal(shared_worker_options(7).name,'7');
  assert.equal(shared_worker_options(null).name,'');assert.equal(shared_worker_options(new String('ignored')).name,'');
  assert.throws(()=>shared_worker_options(Symbol()),TypeError);
  const order=[],values={credentials:'include',name:null,type:'module',extendedLifetime:{}};
  const inherited=Object.fromEntries(Object.keys(values).map(name=>[name,{get(){order.push(name);return values[name];}}]));
  const options=Object.create(Object.defineProperties({},inherited));
  assert.deepEqual(shared_worker_options(options),{credentials:'include',name:'null',type:'module',extendedLifetime:true});
  assert.deepEqual(order,['credentials','name','type','extendedLifetime']);
  let read=false;assert.throws(()=>shared_worker_options({type:'invalid',get extendedLifetime(){read=true;}}),TypeError);assert.equal(read,false);
});

test('Concurrent shared worker constructors share one creation and captured options',async()=>{
  const gate=deferred();let calls=0,environment;
  const registry=new SharedWorkerRegistry({create:(settings,initial,env)=>{calls++;environment=env;assert.equal(settings.options.name,'captured');return gate.promise;}});
  try{
    const options={name:'captured'},first=registry.acquire('first',profile(options)),second=registry.acquire('second',profile({name:'captured'}));options.name='changed';
    await setImmediate();assert.equal(calls,1);assert.deepEqual(environment.owners(),['first','second']);
    const resource={};gate.resolve(resource);const [a,b]=await Promise.all([first,second]);
    assert.equal(a.id,b.id);assert.equal(a.resource,resource);assert.equal(a.created,true);assert.equal(b.created,false);
  }finally{clear(registry);}
});

test('Shared worker identities retain constructor fragments, names, URLs and storage partitions',async()=>{
  const registry=new SharedWorkerRegistry({create:()=>({})});try{
    const acquire=(url,options={},storage_key='top.test|worker.test')=>registry.acquire('owner',{url,options,storage_key});
    const first=await acquire('https://WORKER.test:443/script.js#one',{name:'same'});
    assert.equal((await acquire('https://worker.test/script.js#one',{name:'same'})).id,first.id);
    for(const [url,name,key] of [['https://worker.test/script.js#two','same'],['https://worker.test/other.js','same'],['https://worker.test/script.js#one','other'],['https://worker.test/script.js#one','same','other-partition']])assert.notEqual((await acquire(url,{name},key)).id,first.id);
  }finally{clear(registry);}
});

test('Mismatched shared worker options and security never join or replace a live entry',async()=>{
  const registry=new SharedWorkerRegistry({create:()=>({})});try{
    const first=await registry.acquire('owner',profile());
    for(const options of [{type:'module'},{credentials:'omit'},{extendedLifetime:true}])await assert.rejects(registry.acquire('rejected',profile(options)),{name:'SharedWorkerMismatchError',reason:'options'});
    await assert.rejects(registry.acquire('rejected',{...profile(),secure_context:false}),{reason:'secure-context'});
    assert.equal(registry.owners.has('rejected'),false);assert.equal(registry.ids.size,1);
    assert.equal((await registry.acquire('later',profile())).id,first.id);
  }finally{clear(registry);}
});

test('Retiring one pending owner settles its constructor while another owner retains creation',async()=>{
  const gate=deferred();let signal;
  const registry=new SharedWorkerRegistry({create:(_,__,env)=>{signal=env.signal;return gate.promise;},idleTimeout:0});try{
    const first=registry.acquire('first',profile()),second=registry.acquire('second',profile());await setImmediate();
    registry.releaseOwner('first');await assert.rejects(first,{name:'AbortError'});assert.equal(signal.aborted,false);
    gate.resolve({});const value=await second;assert.ok(value.resource);registry.releaseOwner('second');assert.equal(registry.ids.size,0);
  }finally{clear(registry);}
});

test('Late creations are disposed without overwriting a replacement after all owners retire',async()=>{
  const gates=[deferred(),deferred()],disposed=[];let calls=0;
  const registry=new SharedWorkerRegistry({create:()=>gates[calls++].promise,dispose:value=>disposed.push(value),idleTimeout:0});try{
    const old=registry.acquire('old',profile());await setImmediate();registry.releaseOwner('old');await assert.rejects(old,{name:'AbortError'});
    const current=registry.acquire('current',profile());await setImmediate();gates[1].resolve({current:true});const result=await current;
    gates[0].resolve({old:true});await setImmediate();assert.deepEqual(disposed,[{old:true}]);assert.equal(registry.ids.has(result.id),true);
    assert.equal(registry.close('missing'),false);
  }finally{clear(registry);}
});

test('Owner lifetimes deduplicate repeated constructors and cancel stale idle timers',async()=>{
  const timers=[],cancelled=new Set();let closed=0;
  const registry=new SharedWorkerRegistry({create:()=>({}),dispose:()=>closed++,schedule:(run,delay)=>{timers.push({run,delay});return timers.length-1;},cancel:id=>cancelled.add(id)});try{
    const first=await registry.acquire('owner',profile());await registry.acquire('owner',profile());
    assert.equal(registry.releaseOwner('owner'),1);assert.equal(timers[0].delay,5000);
    const next=await registry.acquire('next',profile());assert.equal(next.id,first.id);assert.equal(cancelled.has(0),true);
    registry.releaseOwner('next');timers[0].run();assert.equal(closed,0);timers[1].run();assert.equal(closed,1);
    const extended=await registry.acquire('extended',profile({extendedLifetime:true}));registry.releaseOwner('extended');assert.equal(timers[2].delay,30000);timers[2].run();assert.equal(registry.ids.has(extended.id),false);
  }finally{clear(registry);}
});

test('Failed factories are evicted and retried without retaining owners',async()=>{
  let calls=0;const registry=new SharedWorkerRegistry({create:()=>{if(!calls++)throw new TypeError('Failed source');return {};}});try{
    await assert.rejects(registry.acquire('first',profile()),/Failed source/);assert.equal(registry.owners.size,0);assert.equal(registry.entries.size,0);
    assert.ok((await registry.acquire('next',profile())).resource);
  }finally{clear(registry);}
});
