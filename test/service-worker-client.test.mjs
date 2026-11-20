import test from 'node:test';
import assert from 'node:assert/strict';
import {create_service_worker_client} from '../src/service_worker/client.mjs';
import {create_obj_proxy,global_method_names} from '../src/frame/global_functions.mjs';

const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
test('Public service worker event adapters preserve native global method binding',()=>{
  const {api}=environment();
  try{
    const target=new EventTarget(),virtual=create_obj_proxy({},[],target);let received=0;
    assert.ok(global_method_names(target).includes('dispatchEvent'));
    virtual.addEventListener('example',()=>received++);
    assert.equal(virtual.dispatchEvent(new Event('example')),true);assert.equal(received,1);
  }finally{api.close();}
});
function environment(){
  const calls=[];let snapshot={revision:0,registrations:[],controller:null,ready:null},api;
  const registration={id:'reg',origin:'https://app.test',scope:'https://app.test/',updateViaCache:'imports',installing:{id:'worker',scriptURL:'https://app.test/worker.js',state:'installing'},waiting:null,active:null};
  api=create_service_worker_client({base:()=> 'https://app.test/page',origin:()=> 'https://app.test',command:async(method,args,ports)=>{
    calls.push({method,args,ports});let value;
    if(method==='register'){
      snapshot={...snapshot,revision:1,registrations:[registration]};value=registration;
      api.receive({type:'state',event:'updatefound',snapshot,registration});
    }else if(method==='get')value=snapshot.registrations[0];else if(method==='list')value=snapshot.registrations;else if(method==='unregister')value=true;
    return {value,snapshot};
  }});
  return {api,calls,registration,activate(){registration.installing=null;registration.active={id:'worker',scriptURL:'https://app.test/worker.js',state:'activated'};snapshot={...snapshot,revision:2,controller:registration.active,ready:'reg'};api.receive({type:'state',event:'controllerchange',snapshot,registration});},state:()=>snapshot};
}
test('Register normalizes virtual URLs and delivers updatefound after callers can attach native listeners',async()=>{
  const {api,calls}=environment();
  try{
    const registration=await api.container.register('/worker.js'),events=[];
    EventTarget.prototype.addEventListener.call(registration,'updatefound',event=>events.push({trusted:event.isTrusted,target:event.target===registration}));
    await tick();assert.deepEqual(events,[{trusted:true,target:true}]);assert.equal(calls[0].args[0],'https://app.test/worker.js');
    assert.equal(await api.container.getRegistration(),registration);assert.equal((await api.container.getRegistrations())[0],registration);
    assert.equal(registration.installing.scriptURL,'https://app.test/worker.js');assert.equal(registration instanceof api.ServiceWorkerRegistration,true);
    await assert.rejects(api.container.register('https://other.test/worker.js'),{name:'SecurityError'});
  }finally{api.close();}
});
test('Ready has stable identity, controller changes retain worker identity and stale snapshots cannot rewind it',async()=>{
  const {api,activate}=environment();
  try{
    const ready=api.container.ready;assert.equal(api.container.ready,ready);const registration=await api.container.register('/worker.js'),worker=registration.installing,events=[];
    api.container.oncontrollerchange=event=>events.push([event.isTrusted,event.target===api.container]);activate();
    assert.equal(await ready,registration);assert.equal(api.container.controller,worker);assert.equal(worker.state,'activated');
    api.apply({revision:0,registrations:[],controller:null,ready:null});assert.equal(api.container.controller,worker);await tick();assert.deepEqual(events,[[true,true]]);
  }finally{api.close();}
});
test('Messages queue until startMessages/onmessage and worker postMessage snapshots and transfers synchronously',async()=>{
  const {api,calls,activate}=environment();
  try{
    const registration=await api.container.register('/worker.js');activate();const source=registration.active,received=[];
    api.receive({type:'message',data:'queued',ports:[],origin:'https://app.test',source:{id:'worker',scriptURL:source.scriptURL,state:'activated'}});
    api.container.addEventListener('message',event=>received.push([event.data,event.source===source,event.isTrusted]));await tick();assert.equal(received.length,0);
    api.container.startMessages();await tick();assert.deepEqual(received,[['queued',true,true]]);
    const buffer=Uint8Array.of(1,2).buffer;source.postMessage({buffer},[buffer]);assert.equal(buffer.byteLength,0);await tick();
    assert.deepEqual([...new Uint8Array(calls.at(-1).args[1].data.buffer)],[1,2]);assert.throws(()=>source.postMessage(()=>{}),{name:'DataCloneError'});
    assert.throws(()=>new api.ServiceWorker(),TypeError);assert.throws(()=>api.ServiceWorker.prototype.postMessage.call({},'x'),TypeError);
  }finally{api.close();}
});
