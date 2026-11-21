import assert from 'node:assert/strict';
import {wait_for} from './wait-for.mjs';

const site='https://crypto-vault.test/page';
export async function verify_crypto_vault(browser,origin){
  const passed=[];
  for(const denied of [false,true]){
    const context=await browser.newContext(),errors=[];
    const deadline=setTimeout(()=>context.close().catch(()=>{}),45000);
    const setup=async(existing)=>{
      const page=existing||await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/host-worker/page');
      if(denied)await page.evaluate(()=>{for(const key of ['localStorage','sessionStorage','indexedDB','caches'])Object.defineProperty(globalThis,key,{get(){throw new DOMException('Storage denied','SecurityError');}});});
      await page.addScriptTag({url:origin+'/host-worker/bundle.js'});
      await page.evaluate(async({site,websocket})=>{
        globalThis.backend=await sandstone.worker_backends.get({websocket});
        await sandstone.worker_backends.share_crypto(backend);
        globalThis.frame=new sandstone.controller.ProxyFrame();document.body.append(frame.iframe);
        frame.special_pages[site]='<!doctype html><body>Shared crypto capabilities';await frame.navigate_to(site);
      },{site,websocket:origin.replace(/^http/,'ws')+'/'});return page;
    };
    const evaluate=(page,source)=>page.evaluate(source=>frame.eval_js(source),source);
    try{
      const first=await setup(),second=await setup(),third=await setup();
      const initial=await first.evaluate(async()=>{
        const handle=await frame.eval_js('(async()=>{globalThis.original=await crypto.subtle.generateKey({name:"HMAC",hash:"SHA-256"},false,["sign"]);return original;})()');
        const signature=await frame.eval_js('(async()=>Array.from(new Uint8Array(await crypto.subtle.sign("HMAC",original,new Uint8Array([1,2,3])))))()');
        return {type:handle.type,signature,backend:backend.identity};
      });
      assert.equal(initial.signature.length,32);assert.ok(initial.type.startsWith('application/x-sandstone-cryptokey;'));
      await first.close();
      await evaluate(second,'globalThis.borrowed=structuredClone(new Blob([],{type:'+JSON.stringify(initial.type)+'}));true');
      // Resolve the foreign key as an IndexedDB input before any crypto call
      // has had an opportunity to populate this UI's local key map.
      if(!denied)await evaluate(second,'(async()=>{const db=await new Promise((resolve,reject)=>{const request=indexedDB.open("vault-persistence",1);request.onupgradeneeded=()=>request.result.createObjectStore("keys");request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});await new Promise((resolve,reject)=>{const tx=db.transaction("keys","readwrite");tx.objectStore("keys").put(borrowed,"saved");tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();return true;})()');
      const use='(async()=>{let error;try{await crypto.subtle.exportKey("raw",borrowed);}catch(value){error=value.name;}return {extractable:borrowed.extractable,usages:borrowed.usages,error,signature:Array.from(new Uint8Array(await crypto.subtle.sign("HMAC",borrowed,new Uint8Array([1,2,3]))))};})()';
      assert.deepEqual(await evaluate(second,use),{extractable:false,usages:['sign'],error:'InvalidAccessError',signature:initial.signature});
      passed.push('Native '+(denied?'memory':'durable')+' crypto vault retains nonextractable keys after their creating UI closes');
      await evaluate(second,'globalThis.sender=new BroadcastChannel("vault");true');
      await evaluate(third,'globalThis.messages=[];globalThis.receiver=new BroadcastChannel("vault");receiver.onmessage=event=>{messages.push(event.data);};true');
      await third.evaluate(()=>{
        const request=backend.request;globalThis.vaultHeld=false;
        backend.request=(op,...args)=>{
          if(op!=='keys-store')return request(op,...args);
          backend.request=request;vaultHeld=true;return new Promise((resolve,reject)=>{globalThis.commitVault=()=>request(op,...args).then(resolve,reject);});
        };
      });
      await evaluate(second,'sender.postMessage({kind:"key",key:borrowed});sender.postMessage({kind:"later"});true');
      await third.waitForFunction(()=>globalThis.vaultHeld);
      assert.equal(await evaluate(third,'messages.length'),0,'A receiver observed a key before its vault commit');
      await third.evaluate(()=>commitVault());
      await wait_for(async()=>await evaluate(third,'messages.length')===2);
      assert.deepEqual(await evaluate(third,'messages.map(value=>value.kind)'),['key','later']);
      const workerResult=await third.evaluate(async()=>{
        const handle=await frame.eval_js('messages[0].key'),channel=new MessageChannel();
        const service=await backend.request('open',{context:{url:'https://crypto-vault.test/worker.js'}},[channel.port1]);
        try{
          const result=new Promise(resolve=>{channel.port2.onmessage=event=>resolve(event.data);});channel.port2.start();
          channel.port2.postMessage({type:'procedure',id:'sign',procedure:'crypto',arguments:[service.profile.frame_id,'sign',['HMAC',handle,new Uint8Array([1,2,3])]]});
          const reply=await result;if(!reply.content.success)throw reply.content.value;
          return Array.from(new Uint8Array(reply.content.value));
        }finally{channel.port2.close();await backend.request('close',{worker:service.id});}
      });
      assert.deepEqual(workerResult,initial.signature);
      passed.push('Native '+(denied?'memory':'durable')+' broadcast delivery waits for key publication, preserves order and permits retained-worker use');
      if(!denied){
        const observer=await context.newPage();await observer.goto(origin+'/host-worker/page');
        await second.close();await third.close();
        await wait_for(async()=>observer.evaluate(async()=>{
          const locks=await navigator.locks.query();return ![...locks.held,...locks.pending].some(lock=>lock.name.startsWith('sandstone.shared-backend.v1:')||lock.name.startsWith('sandstone.backend-owner.v1:'));
        }));
        const restored=await setup(observer);assert.notEqual(await restored.evaluate(()=>backend.identity),initial.backend);
        const signature=await evaluate(restored,'(async()=>{const db=await new Promise((resolve,reject)=>{const request=indexedDB.open("vault-persistence",1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});const key=await new Promise((resolve,reject)=>{const tx=db.transaction("keys");const request=tx.objectStore("keys").get("saved");request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});db.close();return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC",key,new Uint8Array([1,2,3]))));})()');
        assert.deepEqual(signature,initial.signature);
        passed.push('Native IndexedDB restores nonextractable key material into a fresh UI and crypto vault');
      }
      assert.deepEqual(errors,[]);
    }finally{clearTimeout(deadline);await context.close();}
  }
  return passed;
}
