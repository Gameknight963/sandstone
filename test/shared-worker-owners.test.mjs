import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {SharedWorkerOwners,delegate_prefix} from '../src/shared_worker/owners.mjs';
import {MemoryLockManager} from '../src/locks/manager.mjs';
import {hold_lock} from '../src/host/worker_discovery.mjs';

const deferred=()=>{let resolve;const promise=new Promise(value=>{resolve=value;});return {promise,resolve};};
const descriptor=(url='https://actor.test/worker.js')=>({storage_key:'https://actor.test',url,secure_context:true,options:{name:'shared'}});
async function until(predicate){const deadline=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<deadline,'Owner protocol did not settle');await setImmediate();}}
function fixture(t,options={}){
  let profiles=0;
  const actors=new SharedWorkerOwners({idleTimeout:0,createProfile:()=>{profiles++;return {url:'data:text/javascript,onconnect=()=>{}'};},...options});
  t.after(()=>actors.close());return {actors,profiles:()=>profiles};
}
function ui(t,actors,{owner,connect,lifetime}={}){
  const channel=new MessageChannel(),controller=new AbortController(),stats={owners:0,connections:0,closes:0},peers=new Set();
  const client=actors.addUI(channel.port1,lifetime||{signal:controller.signal});
  channel.port2.onmessage=async event=>{
    const message=event.data;if(message.type!=='request')return;
    try{
      let value=true,ports=[];
      if(message.op==='owner'){stats.owners++;await owner?.(message);}
      if(message.op==='connect'){
        stats.connections++;const pair=new MessageChannel();peers.add(pair.port1);
        pair.port1.onmessage=event=>pair.port1.postMessage(event.data);
        await connect?.(message,pair.port1);value={client:stats.connections};ports=[pair.port2];
      }
      if(message.op==='close')stats.closes++;
      channel.port2.postMessage({type:'reply',id:message.id,ok:true,value},ports);
    }catch(error){try{channel.port2.postMessage({type:'reply',id:message.id,ok:false,error:{name:error.name,message:error.message}});}catch{}}
  };
  t.after(()=>{client.close();channel.port2.close();for(const port of peers)port.close();});
  return {...client,controller,stats,notify:message=>channel.port2.postMessage(message)};
}
const echo=(port,value)=>new Promise(resolve=>{port.onmessage=event=>resolve(event.data);port.postMessage(value);});

test('Concurrent UI constructors reuse one actor profile and one native owner document per UI',async t=>{
  const {actors,profiles}=fixture(t),a=ui(t,actors),b=ui(t,actors);
  const clients=await Promise.all([actors.acquire(a.id,'document',descriptor()),actors.acquire(a.id,'second',descriptor()),actors.acquire(b.id,'document',descriptor())]);
  t.after(()=>clients.forEach(client=>client.port.close()));
  assert.equal(profiles(),1);assert.equal(new Set(clients.map(client=>client.id)).size,1);assert.equal(a.stats.owners,1);assert.equal(b.stats.owners,1);
  assert.deepEqual(await Promise.all(clients.map((client,index)=>echo(client.port,index))),[0,1,2]);
  actors.release(a.id,'document');actors.release(a.id,'second');assert.equal(a.stats.closes,0);
  assert.equal(await echo(clients[2].port,'other UI'),'other UI');actors.release(b.id,'document');
  await until(()=>a.stats.closes===1&&b.stats.closes===1);assert.equal(actors.resources.size,0);
});

test('Retiring a document cancels a pending owner setup before it can construct a client',async t=>{
  const {actors}=fixture(t),started=deferred(),held=deferred(),a=ui(t,actors,{owner:async()=>{started.resolve();await held.promise;}});
  const pending=actors.acquire(a.id,'document',descriptor());await started.promise;actors.release(a.id,'document');
  await assert.rejects(pending,{name:'AbortError'});held.resolve();await until(()=>a.stats.closes===1);await setImmediate();assert.equal(a.stats.connections,0);
});

test('A native port returned after document retirement is closed instead of becoming a stale client',async t=>{
  const {actors}=fixture(t),started=deferred(),held=deferred(),peerClosed=deferred();
  const a=ui(t,actors,{connect:async(_,peer)=>{peer.once('close',peerClosed.resolve);started.resolve();await held.promise;}});
  const pending=actors.acquire(a.id,'document',descriptor());await started.promise;actors.release(a.id,'document');
  await assert.rejects(pending,{name:'AbortError'});held.resolve();await peerClosed.promise;assert.equal(a.stats.connections,1);
});

test('Losing a UI rejects its in-flight constructor without replaying it on another delegate',async t=>{
  const {actors,profiles}=fixture(t),started=deferred(),held=deferred(),a=ui(t,actors,{connect:async()=>{started.resolve();await held.promise;}}),b=ui(t,actors);
  const pending=actors.acquire(a.id,'document',descriptor());await started.promise;a.controller.abort();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(b.stats.connections,0);held.resolve();
  const replacement=await actors.acquire(b.id,'document',descriptor());t.after(()=>replacement.port.close());assert.equal(profiles(),2);assert.equal(b.stats.connections,1);
});

test('A failed constructor releases only its own actor membership, retaining another actor used by the same document',async t=>{
  let bad;
  const {actors}=fixture(t),a=ui(t,actors,{connect:message=>{if(message.actor===bad)throw new DOMException('blocked','SecurityError');}});
  const good=await actors.acquire(a.id,'document',descriptor());t.after(()=>good.port.close());
  const original=actors.registry.create;
  actors.registry.create=async(...args)=>{const resource=await original(...args);bad=resource.id;return resource;};
  await assert.rejects(actors.acquire(a.id,'document',descriptor('https://actor.test/blocked.js')),{name:'SecurityError'});
  assert.equal(actors.registry.ids.size,1);assert.equal(await echo(good.port,'alive'),'alive');assert.equal(actors.release(a.id,'document'),1);
});

test('Native UI lease release removes its memberships and all lifetime watches',async t=>{
  const locks=new MemoryLockManager(),{actors}=fixture(t,{locks}),lease=await hold_lock(delegate_prefix+crypto.randomUUID(),{locks});
  const a=ui(t,actors,{lifetime:{lease:lease.name}}),client=await actors.acquire(a.id,'document',descriptor());t.after(()=>client.port.close());
  lease.close();await until(()=>actors.uis.size===0);assert.equal(actors.registry.ids.size,0);await setImmediate();assert.deepEqual(await locks.query(),{held:[],pending:[]});
});

test('Delegate notices invalidate removed owner documents and report constructor errors with UI identity',async t=>{
  const errors=[],{actors}=fixture(t,{onError:error=>errors.push(error)}),a=ui(t,actors),first=await actors.acquire(a.id,'document',descriptor());t.after(()=>first.port.close());
  a.notify({type:'constructor-error',actor:first.id,client:first.client,message:'script failed'});await until(()=>errors.length===1);assert.equal(errors[0].ui,a.id);
  a.notify({type:'owner-closed',actor:first.id});await until(()=>actors.registry.ids.get(first.id).resource.uis.size===0);
  const second=await actors.acquire(a.id,'document',descriptor());t.after(()=>second.port.close());assert.equal(a.stats.owners,2);
});

test('One failing constructor cannot release a concurrent successful constructor in the same document',async t=>{
  const {actors}=fixture(t);let calls=0;
  const a=ui(t,actors,{connect:()=>{if(++calls===1)throw new DOMException('blocked','SecurityError');}});
  const results=await Promise.allSettled([actors.acquire(a.id,'document',descriptor()),actors.acquire(a.id,'document',descriptor())]);
  assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');
  const client=results[1].value;t.after(()=>client.port.close());assert.equal(await echo(client.port,'retained'),'retained');assert.equal(actors.registry.ids.size,1);
});

test('Logical default and extended idle periods dispose delegated owner documents at their selected deadline',async t=>{
  const scheduled=[],{actors}=fixture(t,{idleTimeout:5,extendedTimeout:30,schedule:(callback,delay)=>{const timer={callback,delay};scheduled.push(timer);return timer;},cancel:()=>{}}),a=ui(t,actors);
  const regular=await actors.acquire(a.id,'regular',descriptor()),extended=await actors.acquire(a.id,'extended',{...descriptor('https://actor.test/extended.js'),options:{name:'shared',extendedLifetime:true}});
  t.after(()=>{regular.port.close();extended.port.close();});actors.release(a.id,'regular');actors.release(a.id,'extended');
  assert.deepEqual(scheduled.map(timer=>timer.delay),[5,30]);assert.equal(a.stats.closes,0);
  scheduled[1].callback();await until(()=>a.stats.closes===1);assert.equal(actors.registry.ids.has(regular.id),true);assert.equal(actors.registry.ids.has(extended.id),false);
  scheduled[0].callback();await until(()=>a.stats.closes===2);
});
