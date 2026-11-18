import test from 'node:test';
import assert from 'node:assert/strict';
import {LockService} from '../src/locks/service.mjs';
import {create_lock_api} from '../src/locks/client.mjs';
const turn=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(check){for(let i=0;i<100;i++){if(await check())return;await turn();}throw new Error('Lock fixture timed out');}
function fixture(){
  const contexts=new Map(),service=new LockService({contexts:()=>contexts,manager:null});
  const client=(id,origin='https://locks.test',top='https://top.test')=>{
    contexts.set(id,{frame:id,context:{url:origin+'/',top_url:top+'/',broadcast_origin:origin}});
    return create_lock_api({open:(name,options,port)=>service.open(id,name,options,port),query:()=>service.query(id)});
  };
  return {contexts,service,client};
}
test('Locks serialize exclusive work, share readers and preserve callback values and errors',async()=>{
  const {client}=fixture(),a=client('a'),b=client('b');let release,started=false;
  const first=a.locks.request('db',async lock=>{assert.ok(lock instanceof a.Lock);assert.equal(lock.name,'db');assert.equal(lock.mode,'exclusive');await new Promise(resolve=>release=resolve);return {value:42};});
  await until(()=>release);
  const second=b.locks.request('db',()=>{started=true;return 'second';});
  await until(async()=> (await b.locks.query()).pending.length===1);assert.equal(started,false);
  release();assert.deepEqual(await first,{value:42});assert.equal(await second,'second');
  let finishA,finishB;
  const readerA=a.locks.request('db',{mode:'shared'},()=>new Promise(resolve=>finishA=resolve));
  const readerB=b.locks.request('db',{mode:'shared'},()=>new Promise(resolve=>finishB=resolve));
  await until(()=>finishA&&finishB);assert.equal((await a.locks.query()).held.length,2);finishA();finishB();await Promise.all([readerA,readerB]);
  const error={unclonable:()=>{}};await assert.rejects(a.locks.request('db',()=>{throw error;}),value=>value===error);
  assert.deepEqual(await a.locks.query(),{held:[],pending:[]});
});

test('Lock snapshots use stable document identities without exposing document capabilities',async()=>{
  const {client}=fixture(),a=client('document-secret-a'),b=client('document-secret-b');let releaseA,releaseB;
  const first=a.locks.request('one',()=>new Promise(resolve=>releaseA=resolve)),second=b.locks.request('two',()=>new Promise(resolve=>releaseB=resolve));
  await until(()=>releaseA&&releaseB);
  const snapshot=await a.locks.query(),again=await b.locks.query();
  assert.deepEqual(snapshot,again);assert.notEqual(snapshot.held[0].clientId,snapshot.held[1].clientId);
  assert.ok(snapshot.held.every(info=>typeof info.clientId==='string'&&!info.clientId.includes('document-secret')));
  releaseA();releaseB();await Promise.all([first,second]);
});
test('Lock queues are fair, ifAvailable returns null and pending aborts preserve their exact reason',async()=>{
  const {client}=fixture(),{locks}=client('a');let release;
  const held=locks.request('x',{mode:'shared'},()=>new Promise(resolve=>release=resolve));await until(()=>release);
  const controller=new AbortController(),reason={why:'cancel'};
  const writer=locks.request('x',{signal:controller.signal},()=>assert.fail('Aborted callback ran'));const rejected=assert.rejects(writer,error=>error===reason);
  await until(async()=> (await locks.query()).pending.length===1);
  assert.equal(await locks.request('x',{mode:'shared',ifAvailable:true},lock=>lock),null);
  controller.abort(reason);await rejected;
  await until(async()=>!(await locks.query()).pending.length);
  release();await held;
  assert.equal(await locks.request('x',{ifAvailable:true},lock=>lock.name),'x');
});
test('Steal rejects held requests and document termination releases held and pending locks',async()=>{
  const {client,service}=fixture(),a=client('a'),b=client('b');let held=false;
  const first=a.locks.request('x',()=>{held=true;return new Promise(()=>{});});const rejected=assert.rejects(first,{name:'AbortError'});
  await until(()=>held);assert.equal(await b.locks.request('x',{steal:true},()=>42),42);await rejected;
  let active=false;
  a.locks.request('x',()=>{active=true;return new Promise(()=>{});});await until(()=>active);
  const waiting=b.locks.request('x',()=>7);await until(async()=> (await b.locks.query()).pending.length===1);
  service.disconnect('a');assert.equal(await waiting,7);assert.equal(service.entries.size,0);
});
test('Lock scope separates virtual origins and top-level sites and rejects opaque or retired documents',async()=>{
  const {client,contexts,service}=fixture(),a=client('a'),b=client('b','https://other.test'),c=client('c','https://locks.test','https://elsewhere.test');let release;
  const held=a.locks.request('x',()=>new Promise(resolve=>release=resolve));await until(()=>release);
  assert.equal(await b.locks.request('x',{ifAvailable:true},lock=>lock.name),'x');assert.equal(await c.locks.request('x',{ifAvailable:true},lock=>lock.name),'x');
  assert.deepEqual(await b.locks.query(),{held:[],pending:[]});
  const opaque=client('opaque','opaque:unique');await assert.rejects(opaque.locks.request('x',()=>{}),{name:'SecurityError'});
  contexts.get('a').retired=true;await assert.rejects(a.locks.query(),{name:'InvalidStateError'});
  assert.throws(()=>service.scope('missing'),{name:'InvalidStateError'});release();await held;
});
test('Lock API validates names, options, receivers and signals without executing callbacks',async()=>{
  const {client}=fixture(),{locks,Lock,LockManager}=client('a');const callback=()=>assert.fail('Invalid callback ran');
  for(const options of [{steal:true,ifAvailable:true},{mode:'shared',steal:true},{ifAvailable:true,signal:new AbortController().signal}])await assert.rejects(locks.request('x',options,callback),{name:'NotSupportedError'});
  await assert.rejects(locks.request('-internal',callback),{name:'NotSupportedError'});
  await assert.rejects(locks.request('x',{mode:'invalid'},callback),{name:'TypeError'});
  await assert.rejects(locks.request('x',{signal:{}},callback),{name:'TypeError'});
  await assert.rejects(locks.request('x',{signal:null},callback),{name:'TypeError'});
  const controller=new AbortController(),reason=()=>{};controller.abort(reason);await assert.rejects(locks.request('x',{signal:controller.signal},callback),value=>value===reason);
  await assert.rejects(locks.request.call({},'x',callback),{name:'TypeError'});assert.throws(()=>new Lock(),{name:'TypeError'});assert.throws(()=>new LockManager(),{name:'TypeError'});
  let reads=0;assert.equal(await locks.request('conversion',{get mode(){reads++;return 'exclusive';}},()=>true),true);assert.equal(reads,1);
});
