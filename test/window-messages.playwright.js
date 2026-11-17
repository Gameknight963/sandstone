async page=>{
  const native=await page.context().newPage(),parentOrigin='https://fixture.test';
  const parent='<!doctype html><body>Messages';
  const child=`<!doctype html><body>Child<script>
    addEventListener('message',async event=>{
      if(event.data?.kind==='crypto'){
        try{
          const signature=await crypto.subtle.sign('HMAC',event.data.key,new Uint8Array([1,2,3]));
          event.source.postMessage({kind:'reply',label:'crypto',key:event.data.key instanceof CryptoKey,signature:Array.from(new Uint8Array(signature))},event.origin);
        }catch(error){event.source.postMessage({kind:'reply',label:'crypto',error:error.name},event.origin);}
        return;
      }
      if(event.data?.kind!=='ping')return;
      const value={kind:'reply',label:event.data.label,origin:event.origin,source:event.source===parent,
        trusted:event.isTrusted,bytes:event.data.buffer?Array.from(new Uint8Array(event.data.buffer)):[],ports:event.ports.length};
      if(event.ports[0])event.ports[0].postMessage('port reply');
      event.source.postMessage(value,event.origin);
    });
    parent.postMessage({kind:'ready',origin:location.origin},${JSON.stringify(parentOrigin)});
  <\/script>`;
  await native.route('https://fixture.test/**',route=>route.fulfill({contentType:'text/html',body:route.request().url().includes('/child')?child:parent}));
  await native.route('https://other.test/**',route=>route.fulfill({contentType:'text/html',body:child}));
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const read=(proxy,source)=>evaluate(proxy,`JSON.stringify(${source})`).then(JSON.parse);
  const until=async(proxy,source)=>{
    const deadline=Date.now()+10000;
    while(!await evaluate(proxy,source)){
      if(Date.now()>deadline){
        const frames=[];for(const frame of (proxy?page:native).frames())try{frames.push(await frame.evaluate(()=>({url:location.href,virtual:globalThis.sandstone_frame?.loader.url,text:document.body?.innerText.slice(0,300)})));}catch{}
        throw new Error('Window message timed out: '+source+' '+JSON.stringify({state:await read(proxy,'({messages,allMessages})'),frames}));
      }
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  };
  const run=async proxy=>{
    const values=[];
    await evaluate(proxy,`globalThis.messages=[];globalThis.allMessages=[];addEventListener('message',event=>{
      allMessages.push({data:event.data,origin:event.origin});
      if(event.data?.kind==='ready'||event.data?.kind==='reply')messages.push({data:event.data,origin:event.origin,source:event.source===child.contentWindow,trusted:event.isTrusted});
      if(event.data==='self')globalThis.selfMessage={origin:event.origin,source:event.source===window,trusted:event.isTrusted};
    });globalThis.child=document.createElement('iframe');document.body.append(child);true`);
    await evaluate(proxy,"(async()=>{globalThis.windowKey=await crypto.subtle.importKey('raw',new Uint8Array([1,2,3,4]),{name:'HMAC',hash:'SHA-256'},false,['sign']);return true;})()");
    for(const [childOrigin,sandboxed] of [[parentOrigin,false],['https://other.test',false],['https://other.test',true]]){
      await evaluate(proxy,`messages=[];${sandboxed?"child.sandbox='allow-scripts';":''}child.src=${JSON.stringify(childOrigin+'/window-messages/child')};true`);
      await until(proxy,'messages.length===1');
      values.push(await read(proxy,'messages[0]'));
      const target=JSON.stringify(sandboxed?'*':childOrigin);
      values.push(await read(proxy,`(()=>{
        const buffer=new Uint8Array([4,8,15,16,23,42]).buffer;
        const channel=new MessageChannel();globalThis.portReply=null;channel.port1.onmessage=event=>{portReply=event.data;channel.port1.close();};
        child.contentWindow.postMessage({kind:'ping',label:'transfer',buffer},${target},[buffer,channel.port2]);
        return buffer.byteLength;
      })()`));
      await until(proxy,'messages.length===2&&portReply!==null');
      values.push(await read(proxy,'({message:messages[1],portReply})'));
      await evaluate(proxy,`globalThis.optionReads=[];child.contentWindow.postMessage({kind:'ping',label:'options',sandstone_message:'user data',origin:'https://forged.test'},{get targetOrigin(){optionReads.push('target');return ${sandboxed?target:target+"+'/path'"};},get transfer(){optionReads.push('transfer');return [];}});true`);
      await until(proxy,'messages.length===3');
      values.push(await read(proxy,'({message:messages[2],optionReads})'));
      await evaluate(proxy,`child.contentWindow.postMessage({kind:'ping',label:'wrong'},'https://wrong.test');child.contentWindow.postMessage({kind:'ping',label:'default'});true`);
      // A following matching message is a barrier on the posted-message queue.
      await evaluate(proxy,`child.contentWindow.postMessage({kind:'ping',label:'barrier'},${target});true`);
      await until(proxy,"messages.some(event=>event.data.label==='barrier')");
      values.push(await read(proxy,'messages.slice(3)'));
      values.push(await read(proxy,`(()=>{
        const errors=[];for(const operation of [
          ()=>child.contentWindow.postMessage(),
          ()=>child.contentWindow.postMessage('x','invalid origin'),
          ()=>child.contentWindow.postMessage(()=>{},${target}),
          ()=>child.contentWindow.postMessage(()=>{},'https://wrong.test'),
          ()=>{const buffer=new ArrayBuffer(1);child.contentWindow.postMessage('x',${target},[buffer,buffer]);}
        ])try{operation();errors.push('none');}catch(error){errors.push(error.name);}return errors;
      })()`));
      const count=await evaluate(proxy,'messages.length');
      await evaluate(proxy,`child.contentWindow.postMessage({kind:'crypto',key:windowKey},${target});true`);
      await until(proxy,'messages.length==='+JSON.stringify(count+1));
      values.push(await read(proxy,'messages.at(-1)'));
    }
    await evaluate(proxy,"window.postMessage('self');true");
    await until(proxy,'!!globalThis.selfMessage');values.push(await read(proxy,'selfMessage'));
    return values;
  };
  try{
    await native.goto(parentOrigin+'/window-messages/start');const expected=await run(false);
    await page.evaluate(async({parent,child,parentOrigin})=>{
      const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=(url,options)=>new URL(url).pathname.startsWith('/window-messages/')?
        Promise.resolve(new Response(url.includes('/child')?child:parent,{headers:{'Content-Type':'text/html'}})):previous(url,options);
      await main_frame.navigate_to(parentOrigin+'/window-messages/start');
    },{parent,child,parentOrigin});
    const actual=await run(true);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Window messaging parity: '+JSON.stringify({expected,actual}));
    return ['Same/cross/opaque-origin frame messages with virtual origins and source identity', 'postMessage target filtering, options and synchronous clone errors', 'Window message ArrayBuffer/MessagePort/CryptoKey transfers and trusted events'];
  }finally{await native.close();}
}
