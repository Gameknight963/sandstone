import test from 'node:test';
import assert from 'node:assert/strict';
import {create_service_worker_events} from '../src/service_worker/events.mjs';
import {create_service_worker_dispatcher} from '../src/service_worker/dispatcher.mjs';

const setup=()=>{const events=create_service_worker_events(),target=new EventTarget(),dispatcher=create_service_worker_dispatcher({events,target});return {events,target,dispatcher};};
const deliver=async(api,type='install')=>{const event=new api.events.ExtendableEvent(type),result=await api.dispatcher.deliver(event);await result.dispatched;return result;};

test('Service dispatcher delivers native callback identities, once, capture and removal',async()=>{
  const api=setup(),log=[];const listener=function(event){assert.equal(this,api.target);assert.equal(event.target,api.target);assert.equal(event.isTrusted,true);log.push('once');};
  try{
    api.dispatcher.addEventListener('install',listener,{once:true});api.dispatcher.addEventListener('install',listener,{once:false});
    await (await deliver(api)).lifetime;await (await deliver(api)).lifetime;assert.deepEqual(log,['once']);
    api.dispatcher.addEventListener('install',listener,true);api.dispatcher.removeEventListener('install',listener,false);
    await (await deliver(api)).lifetime;assert.deepEqual(log,['once','once']);
    api.dispatcher.removeEventListener('install',listener,true);await (await deliver(api)).lifetime;assert.equal(log.length,2);
  }finally{api.dispatcher.destroy();}
});

test('Service dispatcher validates option getters once and preserves abort-driven re-registration',async()=>{
  const api=setup(),log=[],first=new AbortController(),second=new AbortController(),calls=[];
  const listener=()=>log.push('called');
  try{
    const options={};for(const [key,value] of Object.entries({capture:false,once:false,passive:true,signal:first.signal}))Object.defineProperty(options,key,{get(){calls.push(key);return value;}});
    first.signal.addEventListener('abort',()=>api.dispatcher.addEventListener('activate',listener,{signal:second.signal}));
    api.dispatcher.addEventListener('activate',listener,options);assert.deepEqual(calls,['capture','once','passive','signal']);
    first.abort();await (await deliver(api,'activate')).lifetime;assert.deepEqual(log,['called']);
    second.abort();await (await deliver(api,'activate')).lifetime;assert.equal(log.length,1);
    api.dispatcher.addEventListener('activate',listener,{signal:second.signal});await (await deliver(api,'activate')).lifetime;assert.equal(log.length,1);
  }finally{api.dispatcher.destroy();}
});

test('Synthetic service dispatch stays untrusted and once registrations are shared with real delivery',async()=>{
  const api=setup(),log=[];
  try{
    api.dispatcher.addEventListener('message',event=>{log.push(event.isTrusted);assert.throws(()=>event.waitUntil(Promise.resolve()),{name:'InvalidStateError'});},{once:true});
    assert.equal(api.dispatcher.dispatchEvent(new api.events.ExtendableEvent('message')),true);
    await (await deliver(api,'message')).lifetime;assert.deepEqual(log,[false]);
    api.dispatcher.addEventListener('message',event=>log.push(event.target===api.target));
    api.dispatcher.dispatchEvent(new Event('message'));assert.deepEqual(log,[false,true]);
  }finally{api.dispatcher.destroy();}
});

test('Destroying service dispatcher rejects queued event work',async()=>{
  const api=setup();
  const queued=api.dispatcher.deliver(new api.events.ExtendableEvent('activate'));
  const rejected=assert.rejects(queued,{name:'AbortError'});
  api.dispatcher.destroy();await rejected;
  await assert.rejects(api.dispatcher.deliver(new api.events.ExtendableEvent('install')),{name:'InvalidStateError'});
});
