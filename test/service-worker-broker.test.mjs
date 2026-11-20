import test from 'node:test';
import assert from 'node:assert/strict';
import {ServiceWorkerBroker} from '../src/service_worker/broker.mjs';

function environment(){
  const frames={frame:{id:'frame',root_id:'frame',document_context:'document',url:new URL('https://app.test/page'),origin:'https://app.test',broadcast_origin:'https://app.test'}};
  const client={id:'document',frame:'frame',creationURL:'https://app.test/page',url:'https://app.test/page'};
  const record={origin:'https://app.test',scope:'https://app.test/',active:{id:'worker',scriptURL:'https://app.test/worker.js',state:'activated'},waiting:null,installing:null};
  const manager={clients:new Map([[client.id,client]]),records:new Map([['reg',record]]),retired:new Set(),list:async()=>[record],valid(){},describe:record=>({...record,active:record.active&&{id:record.active.id,scriptURL:record.active.scriptURL,state:record.active.state}})};
  client.registration=record;client.controller=record.active;
  return {frames,client,record,manager,broker:new ServiceWorkerBroker({manager,frames:()=>frames})};
}
test('Public broker binds subscriptions and registration handles to the actual document and virtual origin',async()=>{
  const {broker,frames,client,record}=environment(),packets=[],port={start(){},close(){},postMessage:packet=>packets.push(packet)};
  const snapshot=await broker.open('frame','document',port);assert.equal(snapshot.controller.id,'worker');assert.equal(snapshot.ready,snapshot.registrations[0].id);assert.equal(broker.describe(record).id,snapshot.ready);
  broker.notify({event:'controllerchange',record,worker:record.active,client});assert.equal(packets[0].event,'controllerchange');
  frames.frame.document_context='replacement';assert.throws(()=>broker.snapshot('frame','document'),{name:'SecurityError'});broker.notify({event:'statechange',record,worker:record.active});assert.equal(broker.subscribers.size,0);
});
test('Worker client lookups wait for incoming execution readiness and cannot cross origins',async()=>{
  const {broker,manager,record}=environment();const reserved={id:'incoming',reserved:true,creationURL:'https://app.test/new',url:'https://app.test/new',type:'window'};manager.clients.set(reserved.id,reserved);
  const pending=broker.workerCommand(record,record.active,'clients.get',['incoming']);reserved.reserved=false;reserved.frame='frame';broker.notify({event:'clientready',client:reserved});assert.equal((await pending).id,'incoming');
  manager.clients.set('foreign',{id:'foreign',creationURL:'https://other.test/'});assert.equal(await broker.workerCommand(record,record.active,'clients.get',['foreign']),undefined);
  const list=await broker.workerCommand(record,record.active,'clients.matchAll',[{type:'window',includeUncontrolled:true}]);assert.equal(list.length,2);
});

test('Discarded incoming clients settle pending lookups and closed documents release broker handles',async()=>{
  const {broker,manager,record}=environment();const client={id:'incoming',reserved:true,creationURL:'https://app.test/new'};manager.clients.set(client.id,client);
  const pending=broker.workerCommand(record,record.active,'clients.get',[client.id]);manager.clients.delete(client.id);broker.notify({event:'clientgone',client});assert.equal(await pending,undefined);
  broker.describe(record);assert.equal(broker.records.size,1);broker.disconnect('frame');assert.equal(broker.records.size,0);assert.equal(broker.workers.size,0);broker.describe(record);assert.equal(broker.records.size,1);
});
