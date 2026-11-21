import assert from 'node:assert/strict';

function bootstrap(){
  let owner;
  onconnect=event=>{
    event.stopImmediatePropagation();if(owner)return;owner=event.ports[0];
    owner.onmessage=async event=>{
      if(!event.data.init)return;
      const {runtime,options,nonce}=event.data;
      globalThis.__sandstone_bootstrap__={nonce,channels:1};(0,eval)(runtime);
      await sandstone_frame.worker.initialize_shared_worker(options,event.ports[0],owner,nonce);
      owner.postMessage({ready:true,canvas:typeof OffscreenCanvas==='function',bitmap:typeof ImageBitmap==='function'});
    };owner.start();
  };
}

function authored(){
  onconnect=event=>{
    const port=event.ports[0];port.onmessage=async event=>{
      const data=event.data;
      if(data.kind==='key'){
        let error;try{await crypto.subtle.exportKey('raw',data.key);}catch(value){error=value.name;}
        port.postMessage({signature:[...new Uint8Array(await crypto.subtle.sign('HMAC',data.key,new Uint8Array([1,2,3])))],extractable:data.key.extractable,usages:data.key.usages,error});return;
      }
      const transfer=[...event.ports];
      if(data.kind==='graph')transfer.push(data.view.buffer);
      if(data.kind==='streams')transfer.push(data.readable,data.writable,data.transform);
      if(data.kind==='media')transfer.push(data.canvas,data.bitmap);
      port.postMessage(data,transfer);
    };port.start();
  };
}

export async function verify_port_relay(browser,origin){
  const context=await browser.newContext(),errors=[],deadline=setTimeout(()=>context.close().catch(()=>{}),45000);
  let mediaVerified=false;
  const load=async()=>{
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/host-worker/page');
    await page.addScriptTag({url:origin+'/host-worker/bundle.js'});
    await page.evaluate(async websocket=>{globalThis.backend=await sandstone.worker_backends.get({websocket});await sandstone.worker_backends.share_crypto(backend);},origin.replace(/^http/,'ws')+'/');return page;
  };
  try{
    const first=await load(),second=await load();
    const profile=await first.evaluate(async({bootstrap,authored})=>{
      const runtime=await(await fetch('/host-worker/runtime.js')).text(),token=crypto.randomUUID(),nonce=crypto.randomUUID();
      const url='data:text/javascript,'+encodeURIComponent('/* '+token+' */('+bootstrap+')();'),name='port-relay-'+token;
      globalThis.owner=new SharedWorker(url,{name});
      const channel=new MessageChannel(),service=await backend.request('open',{context:{url:'https://port-relay.test/worker.js'}},[channel.port1]);
      const ready=new Promise((resolve,reject)=>{owner.port.onmessage=event=>event.data.ready?resolve(event.data):event.data.type==='error'?reject(new Error(event.data.message)):undefined;owner.onerror=event=>reject(new Error(event.message));});
      const source='('+authored+')();';
      owner.port.postMessage({init:true,nonce,runtime,options:{...service.profile,token,source,sources:{[service.profile.url]:source},type:'classic',credentials:'same-origin',runtime_src:runtime,sync_http:false}},[channel.port2]);
      const features=await ready;await backend.request('control',{worker:service.id,nonce:token},[owner.port]);
      globalThis.frame=new sandstone.controller.ProxyFrame();document.body.append(frame.iframe);
      const page='https://port-relay.test/page';frame.special_pages[page]='<!doctype html><body>Key creator';await frame.navigate_to(page);
      const key=await frame.eval_js('(async()=>{globalThis.key=await crypto.subtle.generateKey({name:"HMAC",hash:"SHA-256"},false,["sign"]);return key;})()');
      const signature=await frame.eval_js('(async()=>[...new Uint8Array(await crypto.subtle.sign("HMAC",key,new Uint8Array([1,2,3])))])()');
      return {url,name,service:service.id,features,type:key.type,signature};
    },{bootstrap:bootstrap.toString(),authored:authored.toString()});
    const early=await second.evaluate(async profile=>{
      globalThis.actor=new SharedWorker(profile.url,{name:profile.name});const channel=new MessageChannel();
      globalThis.client=channel.port1;client.start();
      globalThis.nextMessage=()=>new Promise((resolve,reject)=>{
        const receive=event=>{client.removeEventListener('messageerror',failed);resolve(event);};
        const failed=()=>{client.removeEventListener('message',receive);reject(new Error('Relayed port message could not be deserialized'));};
        client.addEventListener('message',receive,{once:true});client.addEventListener('messageerror',failed,{once:true});
      });
      const received=nextMessage();client.postMessage({kind:'early',value:'queued before bridge registration'});
      globalThis.bridge=await backend.request('bridge',{worker:profile.service},[channel.port2,actor.port]);
      return (await received).data;
    },profile);
    assert.deepEqual(early,{kind:'early',value:'queued before bridge registration'});
    await first.close();
    const keyResult=await second.evaluate(async type=>{
      const received=nextMessage();client.postMessage({kind:'key',key:new Blob([],{type})});return (await received).data;
    },profile.type);
    assert.deepEqual(keyResult,{signature:profile.signature,extractable:false,usages:['sign'],error:'InvalidAccessError'});
    const graph=await second.evaluate(async()=>{
      const pair=new MessageChannel(),other=new MessageChannel(),view=new Uint8Array([1,2,3]);
      globalThis.originalPort=pair.port2;globalThis.otherPort=other.port2;
      const data={kind:'graph',view,buffer:view.buffer,port:pair.port1,sparse:new Array(5),map:new Map(),set:new Set([view])};data.self=data;data.map.set(view.buffer,data);data.sparse[4]=view;
      const received=nextMessage();client.postMessage(data,[view.buffer,pair.port1,other.port1]);const detached=view.byteLength===0,event=await received,value=event.data;
      globalThis.returnedPort=value.port;globalThis.returnedOther=event.ports[1];
      return {detached,trusted:event.isTrusted,ports:event.ports.length,port:value.port===event.ports[0],cycle:value.self===value,map:value.map.get(value.buffer)===value,set:[...value.set][0]===value.view,sparse:!(0 in value.sparse)&&value.sparse[4]===value.view,buffer:value.buffer===value.view.buffer,bytes:[...value.view]};
    });
    assert.deepEqual(graph,{detached:true,trusted:true,ports:2,port:true,cycle:true,map:true,set:true,sparse:true,buffer:true,bytes:[1,2,3]});
    const streams=await second.evaluate(async()=>{
      let closed;const finished=new Promise(resolve=>{closed=resolve;}),writes=[];
      const data={kind:'streams',readable:new ReadableStream({start(controller){controller.enqueue('source');controller.close();}}),writable:new WritableStream({write(value){writes.push(value);},close(){closed();}}),transform:new TransformStream()};
      const received=nextMessage();client.postMessage(data,[data.readable,data.writable,data.transform]);const remote=(await received).data;
      const reader=remote.readable.getReader(),read=await reader.read(),end=await reader.read();
      const writer=remote.writable.getWriter();await writer.write('sink');await writer.close();await finished;
      const transformed=remote.transform.readable.getReader(),next=transformed.read(),output=remote.transform.writable.getWriter();await output.write('transform');const transformedValue=await next,done=transformed.read();await output.close();await done;
      return {read,end,writes,transformed:transformedValue.value};
    });
    assert.deepEqual(streams,{read:{value:'source',done:false},end:{value:undefined,done:true},writes:['sink'],transformed:'transform'});
    if(profile.features.canvas&&profile.features.bitmap){
      const media=await second.evaluate(async()=>{
        const drawing=new OffscreenCanvas(2,2);drawing.getContext('2d').fillRect(0,0,2,2);
        const data={kind:'media',canvas:new OffscreenCanvas(3,2),bitmap:await createImageBitmap(drawing)},received=nextMessage();
        client.postMessage(data,[data.canvas,data.bitmap]);const remote=(await received).data,result={canvas:[remote.canvas.width,remote.canvas.height],bitmap:[remote.bitmap.width,remote.bitmap.height]};remote.bitmap.close();return result;
      });assert.deepEqual(media,{canvas:[3,2],bitmap:[2,2]});mediaVerified=true;
    }
    assert.equal(await second.evaluate(profile=>backend.request('unbridge',{worker:profile.service,bridge}),profile),true);
    const transferred=await second.evaluate(async()=>{
      const a=new Promise(resolve=>{originalPort.onmessage=event=>resolve(event.data);}),b=new Promise(resolve=>{otherPort.onmessage=event=>resolve(event.data);});
      returnedPort.postMessage('referenced');returnedOther.postMessage('unreferenced');const result=await Promise.all([a,b]);
      for(const port of [originalPort,otherPort,returnedPort,returnedOther])port.close();return result;
    });
    assert.deepEqual(transferred,['referenced','unreferenced']);
    await second.evaluate(profile=>backend.request('close',{worker:profile.service}),profile);assert.deepEqual(errors,[]);
    return ['Opaque shared worker messages survive their creating UI and retain nonextractable key permissions','Worker port forwarding preserves queued messages, native trust, cyclic graphs and transferred ports','Native readable, writable and transform streams pass through the retained backend','Transferred ports remain connected after their communication bridge closes',...(mediaVerified?['Native canvas and bitmap transfers pass through the retained backend']:[])];
  }finally{clearTimeout(deadline);await context.close();}
}
