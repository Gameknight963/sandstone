import assert from 'node:assert/strict';

export const shared_worker_identity_script=`const id=Math.random().toString(36);let count=0;onconnect=event=>event.ports[0].postMessage({id,count:++count,url:location.href,name,secure:isSecureContext});`;

// Trusted reference counter resources isolate registry semantics from script
// execution; retained-worker-fixture separately exercises real opaque actors.
export function shared_worker_registry_main(){
  const registry=new sandstone.SharedWorkerRegistry({create:async(descriptor,_,{id})=>{
    await new Promise(resolve=>setTimeout(resolve,10));
    const original=new URL(descriptor.url),url=original.pathname.endsWith('/identity-redirect')?new URL('identity-worker.js',original).href:original.href;
    return {id,count:0,url,name:descriptor.options.name,secure:descriptor.secure_context};
  }});
  onconnect=event=>{
    const port=event.ports[0];port.onmessage=async event=>{
      const {id,url,options}=event.data;
      try{
        const {resource}=await registry.acquire(port,{url,options,storage_key:'native-reference',secure_context:isSecureContext});
        port.postMessage({id,value:{...resource,count:++resource.count}});
      }catch(error){port.postMessage({id,value:{error:error.name==='SharedWorkerMismatchError'?'Event':error.name,message:null}});}
    };port.start();
  };
}

export async function verify_shared_worker_registry(browser,origin){
  const context=await browser.newContext();try{
    const page=await context.newPage();await page.goto(origin+'/host-worker/page');
    const result=await page.evaluate(async()=>{
      const workers=[],backend=new SharedWorker('/host-worker/registry.js',{name:'registry-'+crypto.randomUUID()}),pending=new Map();let sequence=0;
      backend.port.onmessage=event=>{pending.get(event.data.id)?.(event.data.value);pending.delete(event.data.id);};
      const simulated=(path,options)=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);backend.port.postMessage({id,url:new URL(path,location.href).href,options});});
      const native=(path,options)=>new Promise(resolve=>{
        const worker=new SharedWorker(path,options);workers.push(worker);
        worker.port.onmessage=event=>resolve(event.data);worker.onerror=event=>{event.preventDefault();resolve({error:event.constructor.name,message:event.message??null});};
      });
      const rows=[['identity-worker.js','alpha'],['identity-worker.js',{name:'alpha'}],['identity-worker.js#one',{name:'alpha'}],['identity-worker.js',{name:'beta'}],['identity-other.js',{name:'alpha'}],['identity-worker.js',{name:'alpha',credentials:'omit'}],['identity-worker.js',{name:'alpha',type:'module'}],['identity-worker.js',{name:'alpha',extendedLifetime:true}],['identity-redirect',{name:'redirect'}],['identity-worker.js',{name:'redirect'}],['identity-redirect',{name:'redirect'}],['identity-module.js',{name:'module',type:'module'}],['identity-module.js',{name:'module',type:'module',credentials:'include'}],['identity-worker.js',7],['identity-worker.js',{name:'extended',extendedLifetime:true}],['identity-worker.js',{name:'extended'}]];
      const expected=[],actual=[];
      for(const [path,options] of rows){expected.push(await native(path,options));actual.push(await simulated(path,options));}
      expected.push(...await Promise.all(Array.from({length:3},()=>native('identity-worker.js',{name:'concurrent'}))));
      actual.push(...await Promise.all(Array.from({length:3},()=>simulated('identity-worker.js',{name:'concurrent'}))));
      const normalize=values=>{const ids=new Map();return values.map(value=>{if(!value.id)return value;if(!ids.has(value.id))ids.set(value.id,ids.size+1);return {...value,id:ids.get(value.id)};});};
      return {expected:normalize(expected),actual:normalize(actual)};
    });
    assert.deepEqual(result.actual,result.expected);
    return ['Shared worker registry matches native constructor URLs, fragments, names and redirect identity','Shared worker registry matches native type, credentials and extended-lifetime mismatch errors','Concurrent shared worker constructors reuse one initialization'];
  }finally{await context.close();}
}
