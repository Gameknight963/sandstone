import assert from 'node:assert/strict';
import {create_service_worker_events} from '../src/service_worker/events.mjs';
import {create_service_worker_dispatcher} from '../src/service_worker/dispatcher.mjs';

async function control(createEvents,createDispatcher){
  const events=createEvents(),dispatcher=createDispatcher({events}),passed=[];
  const check=(value,name)=>{if(!value)throw new Error(name);passed.push(name);};
  const deliver=async event=>{const result=await dispatcher.deliver(event);await result.dispatched;return result;};
  try{
    const order=[];
    dispatcher.addEventListener('fetch',event=>{
      check(event.isTrusted&&event.target===self&&event.currentTarget===self,'Trusted delivery retains the logical worker target');
      order.push('first');Promise.resolve().then(()=>{order.push('microtask');event.respondWith(new Response('answer'));});
    },{once:true});
    dispatcher.addEventListener('fetch',()=>order.push('second'),{once:true});
    const event=new events.FetchEvent('fetch',{request:new Request('https://virtual.test/asset')});
    const result=await deliver(event),handle=await result.response;
    check(order.join(',')==='first,microtask','Microtask respondWith stops subsequent native listeners');
    check(new TextDecoder().decode((await handle.reader.read()).value)==='answer','Dispatched fetch responses stream their bytes');
    await handle.reader.cancel();events.finish_fetch(event);await result.lifetime;

    dispatcher.addEventListener('activate',event=>event.preventDefault(),{passive:true,once:true});
    const passive=await deliver(new events.ExtendableEvent('activate',{cancelable:true}));await passive.lifetime;
    check(!passive.canceled,'Passive event listeners cannot cancel the event');
    dispatcher.addEventListener('activate',event=>Promise.resolve().then(()=>event.preventDefault()),{passive:true,once:true});
    const later=await deliver(new events.ExtendableEvent('activate',{cancelable:true}));await later.lifetime;
    check(later.canceled,'Passive listener restrictions end before its queued microtasks');

    let release;const gate=new Promise(resolve=>release=resolve);
    dispatcher.addEventListener('install',event=>event.waitUntil(gate),{once:true});
    const pending=await deliver(new events.ExtendableEvent('install'));
    const rejection=pending.lifetime.then(()=>false,error=>error.name==='AbortError');
    dispatcher.destroy();check(await rejection,'Termination rejects active event lifetimes');release();
    return passed;
  }finally{dispatcher.destroy();}
}

export async function verifyServiceWorkerDispatcher(page){
  const source=`const native_event_target={addEventListener:EventTarget.prototype.addEventListener,removeEventListener:EventTarget.prototype.removeEventListener,dispatchEvent:EventTarget.prototype.dispatchEvent};
(${control})(${create_service_worker_events},${create_service_worker_dispatcher}).then(passed=>postMessage({passed}),error=>postMessage({error:error.stack}));`;
  const report=await page.evaluate(source=>new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'})),worker=new Worker(url);
    const timer=setTimeout(()=>{cleanup();reject(new Error('Service dispatcher control timed out'));},10000);
    function cleanup(){clearTimeout(timer);worker.terminate();URL.revokeObjectURL(url);}
    worker.onmessage=event=>{cleanup();resolve(event.data);};
    worker.onerror=event=>{event.preventDefault();cleanup();reject(new Error(event.message));};worker.postMessage(null);
  }),source);
  assert.equal(report.error,undefined,report.error);assert.equal(report.passed.length,6);
  return report.passed.map(name=>'Service worker dispatcher: '+name);
}
