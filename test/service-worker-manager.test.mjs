import test from 'node:test';
import assert from 'node:assert/strict';
import {ServiceWorkerManager} from '../src/service_worker/manager.mjs';
import {ServiceWorkerStorage} from '../src/service_worker/storage.mjs';

const origin='https://lifecycle.test',scope=origin+'/',context={base:origin+'/page',origin};
const gate=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function environment(){
  const storage=new ServiceWorkerStorage(),owners=[],requests=[],notifications=[];let source='one',number=0,installGate,installError,activationError,activationGate,workerGate;
  const files=new Map();
  const manager=new ServiceWorkerManager({storage,id:()=>String(++number),notify:event=>notifications.push(event),
    fetch:async(url,options)=>{requests.push({url,options});return new Response(files.get(url)??source,{headers:{'content-type':'text/javascript'}});},
    createWorker:async(profile,options)=>{
      const owner={profile,options,events:[],closed:false,close(){this.closed=true;},scripts:async()=>[...profile.scripts,...[...files].filter(([url])=>!profile.scripts.some(script=>script.url===url)).map(([url,source])=>({url,source,headers:[['content-type','text/javascript']]}))],
        dispatch(event){
          this.events.push(event.event);let reads=0;
          const result=Promise.resolve(event.event==='fetch'?{type:'response',body:true}:{type:'dispatched'});
          const lifetime=event.event==='install'?(installError?Promise.reject(installError):installGate?.promise||Promise.resolve()):event.event==='activate'?(activationError?Promise.reject(activationError):activationGate?.promise||Promise.resolve()):Promise.resolve();
          lifetime.catch(()=>{});
          return {result,lifetime,read:async()=>++reads===1?{value:Uint8Array.of(41),done:false}:{done:true},cancel:async()=>{},handled:async()=>{},release:async()=>{}};
        }};
      owners.push(owner);options.signal.addEventListener('abort',()=>owner.close(),{once:true});await workerGate?.promise;return owner;
    }});
  const register=()=>manager.register(origin+'/worker.js',{},context);
  const close=()=>{manager.revoke('lifecycle.test');storage.close();};
  return {manager,storage,owners,requests,notifications,files,register,close,set source(value){source=value;},set installGate(value){installGate=value;},set installError(value){installError=value;},set activationError(value){activationError=value;},set activationGate(value){activationGate=value;},set workerGate(value){workerGate=value;}};
}
test('Registration resolves while install work is pending, then persists and activates the installed worker',async()=>{
  const api=environment(),pending=gate();api.installGate=pending;
  try{
    const record=await api.register();assert.equal(record.installing.state,'installing');assert.equal(record.active,null);assert.equal((await api.storage.list(origin)).length,0);
    assert.equal(await api.manager.get(origin,scope+'#fragment'),record);
    pending.resolve();await api.manager.settled(record);assert.equal(record.active.state,'activated');assert.equal(record.installing,null);
    assert.deepEqual(api.owners[0].events,['install','activate']);assert.equal((await api.storage.list(origin))[0].state.active.id,record.active.id);
    assert.equal(api.requests[0].options.headers['Service-Worker'],'script');
  }finally{api.close();}
});

test('Concurrent document lookups share one registration object and one storage read',async()=>{
  const api=environment();let reads=0;const read=api.storage.read.bind(api.storage);api.storage.read=(...args)=>{reads++;return read(...args);};
  try{
    const records=await Promise.all(Array.from({length:20},()=>api.manager.load(origin,scope)));
    assert.equal(reads,1);assert.ok(records.every(record=>record===records[0]));assert.equal(api.manager.records.size,1);
  }finally{api.close();}
});

test('A cleared generation cannot hold up or overwrite a fresh registration lookup',async()=>{
  const api=environment(),pending=gate(),begin=api.storage.begin.bind(api.storage);let calls=0;
  api.storage.begin=async(...args)=>{if(++calls===1)await pending.promise;return begin(...args);};
  try{
    const old=assert.rejects(api.manager.load(origin,scope),{name:'AbortError'});api.manager.revoke('lifecycle.test');
    const fresh=await api.manager.load(origin,scope);pending.resolve();await old;
    assert.equal(calls,2);assert.equal(await api.manager.load(origin,scope),fresh);
  }finally{pending.resolve();api.close();}
});
test('A rejected install preserves the old active worker and controller',async()=>{
  const api=environment();
  try{
    const record=await api.register();await api.manager.settled(record);const active=record.active;
    const client=api.manager.addClient({id:'client',url:context.base});api.manager.control(client,record,active);
    api.source='two';api.installError=new Error('Installation failed');await api.register();await assert.rejects(api.manager.settled(record),/Installation failed/);
    assert.equal(record.active,active);assert.equal(client.controller,active);assert.equal(api.owners[0].closed,false);assert.equal(api.owners[1].closed,true);
    assert.equal((await api.storage.read(origin,scope)).state.active.id,active.id);assert.equal(record.waiting,null);
  }finally{api.close();}
});
test('An installed update waits for controlled clients unless skipWaiting selects it',async()=>{
  const api=environment();
  try{
    const record=await api.register();await api.manager.settled(record);const previous=record.active;
    const client=api.manager.addClient({id:'client',url:context.base});api.manager.control(client,record,previous);
    api.source='two';await api.register();await api.manager.settled(record);assert.equal(record.waiting.state,'installed');assert.equal(record.active,previous);
    api.manager.command(record,record.waiting,'skipWaiting');await api.manager.settled(record);
    assert.equal(record.active.source,'two');assert.equal(client.controller,record.active);assert.equal(previous.state,'redundant');assert.equal(api.owners[0].closed,true);
  }finally{api.close();}
});
test('Activation waits for an old response body even when its background event work has finished',async()=>{
  const api=environment();
  try{
    const record=await api.register();await api.manager.settled(record);const previous=record.active;
    const client=api.manager.addClient({id:'client',url:context.base});api.manager.control(client,record,previous);
    const job=await api.manager.dispatch(record,previous,{event:'fetch'});await job.result;await job.lifetime;
    api.source='two';await api.register();await api.manager.settled(record);let skipped=false;
    api.manager.command(record,record.waiting,'skipWaiting').then(()=>skipped=true);await api.manager.settled(record);
    assert.equal(skipped,false);
    assert.equal(record.active,previous);assert.equal(api.owners[0].closed,false);
    assert.deepEqual([...((await job.read()).value)],[41]);assert.equal((await job.read()).done,true);await api.manager.settled(record);
    assert.equal(record.active.source,'two');assert.equal(previous.pending,0);assert.equal(api.owners[0].closed,true);assert.equal(skipped,true);
  }finally{api.close();}
});

test('A fetch reservation retains its owner until the host acknowledges delivery, even after EOF',async()=>{
  const api=environment();
  try{
    const record=await api.register();await api.manager.settled(record);const worker=record.active;
    const job=await api.manager.dispatch(record,worker,{event:'fetch'},{waitHandled:true});
    await job.result;await job.lifetime;await job.read();await job.read();
    assert.equal(worker.pending,1);await job.handled();assert.equal(worker.pending,0);
    await job.handled();assert.equal(worker.pending,0);
  }finally{api.close();}
});
test('Import-only changes install new versions while an unchanged graph reuses its worker',async()=>{
  const api=environment();api.files.set(origin+'/dependency.js','one');
  try{
    const record=await api.register();await api.manager.settled(record);const previous=record.active;
    await api.register();await api.manager.settled(record);assert.equal(api.owners.length,1);
    api.files.set(origin+'/dependency.js','two');await api.register();await api.manager.settled(record);
    assert.notEqual(record.active.id,previous.id);assert.equal(record.active.scripts.find(script=>script.url.endsWith('dependency.js')).source,'two');
  }finally{api.close();}
});
test('Unregister removes durable lookup while retaining a controlled worker until its last client leaves',async()=>{
  const api=environment();
  try{
    const record=await api.register();await api.manager.settled(record);const client=api.manager.addClient({id:'client',url:context.base});api.manager.control(client,record,record.active);
    assert.equal(await api.manager.unregister(origin,scope),true);assert.equal((await api.storage.list(origin)).length,0);assert.equal(api.owners[0].closed,false);
    api.manager.removeClient('client');assert.equal(api.owners[0].closed,true);assert.equal(record.active.state,'redundant');
  }finally{api.close();}
});
test('Activation cleanup rejection still leaves the replacement activated',async()=>{
  const api=environment();api.activationError=new Error('Cleanup failed');
  try{const record=await api.register();await api.manager.settled(record);assert.equal(record.active.state,'activated');assert.equal(record.active.activationError.message,'Cleanup failed');}
  finally{api.close();}
});
test('Clearing a site aborts an in-flight install and prevents its scripts from becoming registered',async()=>{
  const api=environment(),pending=gate();api.installGate=pending;
  try{
    const record=await api.register(),settled=assert.rejects(api.manager.settled(record),{name:'AbortError'});
    api.manager.revoke('lifecycle.test');await api.storage.clear('lifecycle.test');pending.resolve();await settled;
    assert.equal((await api.storage.list(origin)).length,0);assert.equal(api.owners[0].closed,true);
    api.installGate=null;const fresh=await api.register();await api.manager.settled(fresh);assert.equal(fresh.active.state,'activated');
  }finally{api.close();}
});
test('A worker restart reserves its event before startup so activation cannot overtake an accepted fetch',async()=>{
  const api=environment();
  try{
    const record=await api.register();await api.manager.settled(record);const previous=record.active;
    const client=api.manager.addClient({id:'client',url:context.base});api.manager.control(client,record,previous);
    api.source='two';await api.register();await api.manager.settled(record);
    previous.owner.close();previous.owner=null;const startup=gate();api.workerGate=startup;
    const pending=api.manager.dispatch(record,previous,{event:'fetch'});assert.equal(previous.pending,1);
    api.manager.command(record,record.waiting,'skipWaiting');await api.manager.settled(record);assert.equal(record.active,previous);
    startup.resolve();api.workerGate=null;const job=await pending;await job.result;await job.lifetime;await job.read();await job.read();await api.manager.settled(record);
    assert.equal(record.active.source,'two');assert.equal(previous.pending,0);
  }finally{api.close();}
});
test('A terminated owner releases its event reservation and can be restarted for the next request',async()=>{
  const api=environment();
  try{
    const record=await api.register();await api.manager.settled(record);const worker=record.active;
    worker.owner.dispatch=()=>{throw new DOMException('Closed','InvalidStateError');};
    await assert.rejects(api.manager.dispatch(record,worker,{event:'message'}),{name:'InvalidStateError'});assert.equal(worker.pending,0);assert.equal(worker.owner,null);
    const job=await api.manager.dispatch(record,worker,{event:'message'});await job.result;await job.lifetime;assert.equal(worker.pending,0);
  }finally{api.close();}
});
test('A restored waiting version activates without refetching or repeating installation',async()=>{
  const api=environment();let restored;
  try{
    const record=await api.register();await api.manager.settled(record);const client=api.manager.addClient({id:'client',url:context.base});api.manager.control(client,record,record.active);
    api.source='two';await api.register();await api.manager.settled(record);const waiting=record.waiting.id;
    api.manager.revoke('lifecycle.test');
    restored=new ServiceWorkerManager({storage:api.storage,createWorker:api.manager.createWorker,fetch:async()=>{throw new Error('Unexpected fetch');}});
    const [loaded]=await restored.list(origin);await restored.settled(loaded);
    assert.equal(loaded.active.id,waiting);assert.equal(loaded.active.state,'activated');assert.equal(loaded.waiting,null);
    assert.equal(loaded.active.owner.profile.restoring,true);assert.deepEqual(loaded.active.owner.events,['activate']);
  }finally{restored?.revoke('lifecycle.test');api.close();}
});
test('Client claims honor the longest registration scope and the original creation URL',async()=>{
  const api=environment();
  try{
    const root=await api.register();await api.manager.settled(root);
    const nested=await api.manager.register(origin+'/worker.js',{scope:origin+'/nested/'},context);await api.manager.settled(nested);
    const inside=api.manager.addClient({id:'nested',url:origin+'/nested/page'}),outside=api.manager.addClient({id:'root',url:origin+'/elsewhere'}),foreign=api.manager.addClient({id:'foreign',url:'https://other.test/'});
    const reserved=api.manager.addClient({id:'incoming',url:origin+'/incoming',reserved:true});
    inside.url=origin+'/moved-by-history';
    await api.manager.claim(root,root.active);assert.equal(outside.controller,root.active);assert.equal(inside.controller,null);assert.equal(foreign.controller,null);assert.equal(reserved.controller,null);
    reserved.reserved=false;await api.manager.claim(root,root.active);assert.equal(reserved.controller,root.active);
    await api.manager.claim(nested,nested.active);assert.equal(inside.controller,nested.active);
  }finally{api.close();}
});
test('Fetch events wait for activation work while reserving their accepted request',async()=>{
  const api=environment(),activation=gate();api.activationGate=activation;
  try{
    const record=await api.register();while(!record.active)await new Promise(resolve=>setImmediate(resolve));
    const pending=api.manager.dispatch(record,record.active,{event:'fetch'});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(api.owners[0].events.includes('fetch'),false);assert.ok(record.active.pending>=1);
    activation.resolve();const job=await pending;await job.result;await job.lifetime;await job.cancel();await api.manager.settled(record);
    assert.equal(api.owners[0].events.includes('fetch'),true);assert.equal(record.active.pending,0);
  }finally{activation.resolve();api.close();}
});

test('Messages can finish activation work instead of waiting on the activation they must release',async()=>{
  const api=environment(),activation=gate();api.activationGate=activation;
  try{
    const record=await api.register();while(!record.active)await new Promise(resolve=>setImmediate(resolve));
    const job=await api.manager.dispatch(record,record.active,{event:'message'});await job.result;await job.lifetime;
    assert.equal(record.active.state,'activating');assert.equal(api.owners[0].events.includes('message'),true);activation.resolve();await api.manager.settled(record);
  }finally{activation.resolve();api.close();}
});
