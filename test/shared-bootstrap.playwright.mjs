import assert from 'node:assert/strict';

function authored(){
  let connections=0;
  onconnect=function(event){
    const port=event.ports[0],connection=++connections,connectTrusted=event.isTrusted;
    port.onmessage=event=>{
      const value=event.data;port.postMessage({connection,connectTrusted,trusted:event.isTrusted,value,origin});
      if(value==='instrument native APIs'){
        Object.defineProperty(MessageEvent.prototype,'data',{get(){throw new Error('authored data getter');}});
        MessagePort.prototype.postMessage=()=>{throw new Error('authored postMessage');};
        MessagePort.prototype.close=()=>{throw new Error('authored port close');};
        globalThis.close=()=>{throw new Error('authored scope close');};
      }
    };port.start();
  };
}

export async function verify_shared_bootstrap(browser,origin){
  const context=await browser.newContext(),deadline=setTimeout(()=>context.close().catch(()=>{}),45000);
  const load=async()=>{
    const page=await context.newPage();await page.goto(origin+'/host-worker/page');await page.addScriptTag({url:origin+'/host-worker/bundle.js'});
    await page.evaluate(async websocket=>{
      globalThis.backend=await sandstone.worker_backends.get({websocket});await sandstone.worker_backends.register_owners(backend);
      globalThis.take=port=>new Promise(resolve=>{port.onmessage=event=>{port.onmessage=null;resolve(event.data);};});
      globalThis.acquire=async({document,descriptor})=>{
        const value=await backend.request('actor-acquire',{document,descriptor});
        const port=value.ports[0],hello=await take(port);return {...value,port,hello,descriptor};
      };
      globalThis.initialize=async(actor,source,type='classic')=>{
        const channel=new MessageChannel(),service=await backend.request('open',{context:{url:actor.descriptor.url}},[channel.port1]);
        const runtime=await(await fetch('/host-worker/runtime.js')).text();
        const ready=new Promise((resolve,reject)=>{actor.port.onmessage=event=>{
          const message=event.data;
          if(message.sandstone_actor===actor.profile.nonce&&message.instance===actor.hello.instance&&message.type==='ready'){actor.port.onmessage=null;resolve(message);}
          else if(message.type==='scope-error'||message.type==='error')reject(new Error(message.message));
        };});
        actor.port.postMessage({sandstone_actor:actor.profile.nonce,instance:actor.hello.instance,type:'initialize',runtime,options:{...service.profile,type,source,sources:{[service.profile.url]:source},runtime_src:runtime,sync_http:false}},[channel.port2]);
        return {ready,service:service.id};
      };
    },origin.replace(/^http/,'ws')+'/');return page;
  };
  try{
    const a=await load(),b=await load(),descriptor={storage_key:'https://shared-bootstrap.test',url:'https://shared-bootstrap.test/worker.js',secure_context:true,options:{name:'bootstrap'}};
    const initial=await a.evaluate(async descriptor=>{globalThis.initial=await acquire({document:'initial',descriptor});return {id:initial.id,hello:initial.hello};},descriptor);
    const waiting=await b.evaluate(async descriptor=>{globalThis.control=await acquire({document:'waiting',descriptor});return {id:control.id,hello:control.hello};},descriptor);
    assert.equal(waiting.id,initial.id);assert.equal(waiting.hello.instance,initial.hello.instance);assert.equal(waiting.hello.phase,'bootstrap');
    await a.close();
    const setup=await b.evaluate(async source=>{
      // Wrong nonces must not choose an initializer or change the phase.
      control.port.postMessage({type:'initialize',sandstone_actor:'wrong',instance:control.hello.instance,runtime:'throw 1'});
      const initialized=await initialize(control,source);await initialized.ready;globalThis.service=initialized.service;
      return {type:'ready',instance:control.hello.instance};
    },'('+authored.toString()+')();');assert.equal(setup.instance,initial.hello.instance);
    const active=await b.evaluate(async descriptor=>{
      globalThis.active=await acquire({document:'active',descriptor});const received=take(active.port);active.port.postMessage('client');return {hello:active.hello,value:await received};
    },descriptor);
    assert.equal(active.hello.phase,'ready');assert.equal(active.hello.instance,setup.instance);
    assert.deepEqual(active.value,{connection:1,connectTrusted:true,trusted:true,value:'client',origin:'https://shared-bootstrap.test'});
    await b.evaluate(()=>{
      const closed=take(control.port);control.port.postMessage({sandstone_actor:control.profile.nonce,instance:control.hello.instance,type:'terminate'});return closed;
    });
    await b.evaluate(()=>backend.request('close',{worker:service}));
    const restarted=await b.evaluate(async descriptor=>{
      globalThis.restarted=await acquire({document:'restarted',descriptor});return restarted.hello;
    },descriptor);assert.equal(restarted.phase,'bootstrap');assert.notEqual(restarted.instance,setup.instance);
    const replacementReady=await b.evaluate(async source=>{
      const initialized=await initialize(restarted,source);await initialized.ready;globalThis.service=initialized.service;return restarted.hello.instance;
    },'('+authored.toString()+')();');
    const replacementClient=await b.evaluate(async descriptor=>{
      globalThis.replacementClient=await acquire({document:'replacement-client',descriptor});const received=take(replacementClient.port);replacementClient.port.postMessage('replacement');return {hello:replacementClient.hello,value:await received};
    },descriptor);
    assert.equal(replacementClient.hello.phase,'ready');assert.equal(replacementClient.hello.instance,replacementReady);assert.equal(replacementClient.value.value,'replacement');assert.equal(replacementClient.value.connectTrusted,true);
    // A command from the previous native instance cannot terminate its replacement.
    const stillAlive=await b.evaluate(async oldInstance=>{
      restarted.port.postMessage({sandstone_actor:restarted.profile.nonce,instance:oldInstance,type:'terminate'});
      const received=take(replacementClient.port);replacementClient.port.postMessage('after stale command');return (await received).value;
    },setup.instance);assert.equal(stillAlive,'after stale command');
    await b.evaluate(()=>{const closed=take(restarted.port);restarted.port.postMessage({sandstone_actor:restarted.profile.nonce,instance:restarted.hello.instance,type:'terminate'});return closed;});
    await b.evaluate(()=>backend.request('close',{worker:service}));
    await b.evaluate(id=>backend.request('actor-close',{worker:id}),initial.id);
    const moduleDescriptor={...descriptor,url:'https://shared-bootstrap.test/module.js',options:{name:'module',type:'module'}};
    const moduleReady=await b.evaluate(async({descriptor,source})=>{
      globalThis.moduleControl=await acquire({document:'module-control',descriptor});
      const initialized=await initialize(moduleControl,source+'\nawait new Promise(()=>{});','module');await initialized.ready;globalThis.service=initialized.service;
      return moduleControl.hello.instance;
    },{descriptor:moduleDescriptor,source:'('+authored.toString()+')();'});
    const moduleClient=await b.evaluate(async descriptor=>{
      globalThis.moduleClient=await acquire({document:'module-client',descriptor});const received=take(moduleClient.port);moduleClient.port.postMessage('module');return {hello:moduleClient.hello,value:await received};
    },moduleDescriptor);assert.equal(moduleClient.hello.phase,'ready');assert.equal(moduleClient.hello.instance,moduleReady);assert.equal(moduleClient.value.value,'module');assert.equal(moduleClient.value.connectTrusted,true);
    const instrumented=await b.evaluate(()=>{const received=take(moduleClient.port);moduleClient.port.postMessage('instrument native APIs');return received;});
    assert.equal(instrumented.value,'instrument native APIs');
    const terminated=await b.evaluate(()=>{const closed=take(moduleControl.port);moduleControl.port.postMessage({sandstone_actor:moduleControl.profile.nonce,instance:moduleControl.hello.instance,type:'terminate'});return closed;});
    assert.equal(terminated.type,'closed');assert.equal(terminated.instance,moduleReady);
    await b.evaluate(()=>backend.request('close',{worker:service}));await b.evaluate(()=>backend.request('actor-close',{worker:moduleControl.id}));
    const failureDescriptor={...descriptor,url:'https://shared-bootstrap.test/failure.js',options:{name:'failure'}};
    const failedInstance=await b.evaluate(async descriptor=>{
      globalThis.failureControl=await acquire({document:'failure-control',descriptor});return failureControl.hello.instance;
    },failureDescriptor);
    await assert.rejects(b.evaluate(async()=>{
      const initialized=await initialize(failureControl,'throw new SyntaxError("startup failure");');globalThis.service=initialized.service;await initialized.ready;
    }),/startup failure/);
    await b.evaluate(()=>backend.request('close',{worker:service}));
    const recovered=await b.evaluate(async({descriptor,source})=>{
      globalThis.recoveryControl=await acquire({document:'recovery-control',descriptor});
      const initialized=await initialize(recoveryControl,source);globalThis.service=initialized.service;await initialized.ready;
      const client=await acquire({document:'recovery-client',descriptor}),received=take(client.port);client.port.postMessage('recovered');
      return {hello:recoveryControl.hello,value:await received};
    },{descriptor:failureDescriptor,source:'('+authored.toString()+')();'});
    assert.equal(recovered.hello.phase,'bootstrap');assert.notEqual(recovered.hello.instance,failedInstance);assert.equal(recovered.value.value,'recovered');
    await b.evaluate(()=>{const closed=take(recoveryControl.port);recoveryControl.port.postMessage({sandstone_actor:recoveryControl.profile.nonce,instance:recoveryControl.hello.instance,type:'terminate'});return closed;});
    await b.evaluate(()=>backend.request('close',{worker:service}));await b.evaluate(()=>backend.request('actor-close',{worker:recoveryControl.id}));
    return ['An abandoned bootstrap candidate does not prevent another UI initializing the same opaque actor','Private native instance greetings precede trusted authored connect events','Native scope replacement receives a new identity and ignores stale termination commands','Module startup can become ready before an unresolved top-level await finishes','Authored native API instrumentation cannot disable private termination','A startup failure reports its error and the next constructor starts a fresh native instance'];
  }finally{clearTimeout(deadline);await context.close();}
}
