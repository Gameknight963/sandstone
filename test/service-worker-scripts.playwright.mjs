import assert from 'node:assert/strict';

export async function verifyServiceWorkerScripts(page,{storageDenied=false}={}){
  const fixture=await page.context().newPage(),errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
  try{
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    const captured=await fixture.evaluate(async()=>{
      const outputs=[];
      for(const type of ['classic','module']){
        const origin='https://saved-'+type+'-worker.test',requests=[];
        const source=type==='classic'?`importScripts('./runtime.js');function structuredClone(){throw new Error('Authored clone must stay separate')}
          onmessage=event=>{importScripts('data:text/javascript,'+encodeURIComponent('self.installedData=0;'));
            let missing=null,dataMissing=null;if(event.data.missing){try{importScripts('./missing.js')}catch(error){missing=error.name}
              try{importScripts('data:text/javascript,'+encodeURIComponent('self.uninstalledData=true;'))}catch(error){dataMissing=error.name}}
            event.ports[0].postMessage({value:importedValue+installedData,missing,dataMissing,uninstalled:!!self.uninstalledData})};`:
          `import {value} from './runtime.js';import config from './config.json' with {type:'json'};
          onmessage=event=>event.waitUntil((async()=>{let missing=null,dataMissing=null;if(event.data.missing){try{await import('./missing.js')}catch(error){missing=error.name}
            try{await import('data:text/javascript,export default 1')}catch(error){dataMissing=error.name}}
            event.ports[0].postMessage({value:value+config.offset,missing,dataMissing,uninstalled:false})})());`;
        const previous=sandstone.network.session.fetch;
        sandstone.network.session.fetch=async(url,options)=>{
          if(!url.startsWith(origin+'/'))return previous(url,options);
          requests.push(url);const path=new URL(url).pathname;
          if(path==='/missing.js')return new Response('missing',{status:404});
          if(path==='/runtime.js')return new Response(null,{status:302,headers:{location:origin+'/assets/runtime.js'}});
          const body=path==='/config.json'?'{"offset":1}':path==='/assets/runtime.js'?(type==='classic'?"importScripts('./dependency.js');":"export {value} from './dependency.js';"):
            type==='classic'?'self.importedValue=42;':"import * as runtime from '../runtime.js';export const value=41;export const cycle=runtime;";
          const response=new Response(body,{headers:{'content-type':path==='/config.json'?'application/json':'text/javascript','referrer-policy':'no-referrer'}});
          return response;
        };
        const owner=await sandstone.service_workers.create_service_worker_driver({scope:origin+'/',scriptURL:origin+'/worker.js',source,type});
        try{
          const channel=new MessageChannel(),reply=new Promise(resolve=>channel.port1.onmessage=event=>resolve(event.data));
          const job=owner.dispatch({event:'message',origin,data:{missing:false},ports:[channel.port2]});
          await job.result;await job.lifetime;const value=await reply;channel.port1.close();await job.release();
          const scripts=await owner.scripts(),state={scope:origin+'/',active:{id:type,scriptURL:origin+'/worker.js',source,type,scripts}};
          const storage=sandstone.service_workers.registrations;await storage.clear(new URL(origin).hostname);await storage.commit(await storage.begin(origin),state,0);
          outputs.push({type,origin,source,scripts,requests,value});
        }finally{owner.close();}
      }
      return outputs;
    });
    for(const value of captured){
      assert.deepEqual(value.value,{value:42,missing:null,dataMissing:null,uninstalled:false});assert.ok(value.scripts.length>=3);
      if(value.type==='classic')assert.ok(value.scripts.some(script=>script.url.startsWith('data:')));
      assert.equal(value.scripts.some(script=>script.url.endsWith('/missing.js')),false);
      const runtime=value.scripts.find(script=>script.url===value.origin+'/runtime.js');
      assert.equal(runtime.responseURL,value.origin+'/assets/runtime.js');assert.ok(runtime.headers.some(([key,value])=>key==='referrer-policy'&&value==='no-referrer'));
    }
    await fixture.reload();await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    const restored=await fixture.evaluate(async({captured,storageDenied})=>{
      const outputs=[],network=[];
      sandstone.network.session.fetch=async url=>{network.push(url);throw new TypeError('Network unavailable while restoring');};
      for(const saved of captured){
        const records=await sandstone.service_workers.registrations.list(saved.origin);
        if(records.length!==(storageDenied?0:1))throw new Error('Registration durability differs from storage availability');
        const version=storageDenied?saved:records[0].state.active;
        const owner=await sandstone.service_workers.create_service_worker_driver({scope:saved.origin+'/',scriptURL:saved.origin+'/worker.js',source:version.source,type:saved.type,scripts:version.scripts,restoring:true});
        try{
          const channel=new MessageChannel(),reply=new Promise(resolve=>channel.port1.onmessage=event=>resolve(event.data));
          const job=owner.dispatch({event:'message',origin:saved.origin,data:{missing:true},ports:[channel.port2]});
          await job.result;await job.lifetime;const value=await reply;channel.port1.close();await job.release();
          outputs.push({type:saved.type,value});
        }finally{owner.close();}
      }
      return {outputs,network};
    },{captured,storageDenied});
    assert.deepEqual(restored,{outputs:[{type:'classic',value:{value:42,missing:'NetworkError',dataMissing:'NetworkError',uninstalled:false}},{type:'module',value:{value:42,missing:'NetworkError',dataMissing:'NetworkError',uninstalled:false}}],network:[]});
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Classic service workers restart from saved imports without network access','Module service workers restore redirected dependencies, cycles and JSON modules from installed sources','Restored workers reject missing imports without fetching new scripts'];
  }finally{
    await fixture.evaluate(async()=>{for(const type of ['classic','module'])await sandstone.service_workers.clear_registrations('saved-'+type+'-worker.test');}).catch(()=>{});
    await fixture.close();
  }
}
