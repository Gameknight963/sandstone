async page=>{
  const url='https://bootstrap.test/parent';
  const evaluate=source=>page.evaluate(source=>main_frame.eval_js(source),source);
  const until=async predicate=>{const deadline=Date.now()+10000;while(!await predicate()){if(Date.now()>deadline)throw new Error('Bootstrap message fixture timed out');await new Promise(resolve=>setTimeout(resolve,20));}};
  const child='<!doctype html><body>Bootstrap child<script>addEventListener("message",event=>{if(!event.data?.pagePacket)return;parent.postMessage({bootstrapEcho:event.data,ports:event.ports.length},"*");event.ports[0]?.postMessage("application-port");});parent.postMessage({bootstrapReady:true},"*");<\/script>';
  await page.evaluate(async({url,child})=>{
    const previous=sandstone.network.session.fetch;
    sandstone.network.session.fetch=(target,options)=>target==='https://bootstrap.test/child'?Promise.resolve(new Response(child,{headers:{'Content-Type':'text/html'}})):previous(target,options);
    main_frame.special_pages[url]='<!doctype html><body>Bootstrap parent';await main_frame.navigate_to(url);
  },{url,child});
  await evaluate(`globalThis.bootstrapMessages=[];globalThis.privateBootstrapLeaks=[];globalThis.bootstrapEchoes=[];
    globalThis.restoreBootstrapStop=Event.prototype.stopImmediatePropagation;
    Event.prototype.stopImmediatePropagation=function(){if(this.type!=='message')return restoreBootstrapStop.call(this);};
    addEventListener('message',event=>{if(event.data?.sandstone_bootstrap===1&&!event.data.pagePacket)privateBootstrapLeaks.push(event.data.type);if(event.data?.bootstrapReady)bootstrapMessages.push('ready');if(event.data?.bootstrapEcho)bootstrapEchoes.push({data:event.data.bootstrapEcho,ports:event.data.ports});});
    globalThis.bootstrapChild=document.createElement('iframe');bootstrapChild.src='/child';document.body.append(bootstrapChild);true`);
  try{
    await until(()=>evaluate('bootstrapMessages.length===1'));
    const packets=[{type:'ping',url:'https://bootstrap.test/child',id:'page-ping',pagePacket:true},{type:'set_host',sandstone_bootstrap:1,nonce:'page-nonce',pagePacket:true},{type:'pong',sandstone_bootstrap:1,id:'page-pong',pagePacket:true}];
    const echoed=await evaluate(`(async()=>{
      const results=[];
      for(const packet of ${JSON.stringify(packets)}){
        const channel=new MessageChannel(),reply=new Promise(resolve=>channel.port1.onmessage=event=>resolve(event.data));
        bootstrapChild.contentWindow.postMessage(packet,'*',[channel.port2]);results.push(await reply);channel.port1.close();
      }
      return JSON.stringify(results);
    })()`);
    if(JSON.stringify(JSON.parse(echoed))!==JSON.stringify(packets.map(()=>'application-port')))throw new Error('Bootstrap-like application messages lost their ports');
    await until(()=>evaluate('bootstrapEchoes.length===3'));
    const data=JSON.parse(await evaluate('JSON.stringify({echoes:bootstrapEchoes,leaks:privateBootstrapLeaks})'));
    if(JSON.stringify(data.echoes)!==JSON.stringify(packets.map(data=>({data,ports:1})))||data.leaks.length)throw new Error('Bootstrap traffic leaked into application messages: '+JSON.stringify(data));
    const workerResult=await evaluate(`(async()=>{
      const code='onmessage=event=>{postMessage(event.data);};';
      const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'})),worker=new Worker(url);
      try{const packet=${JSON.stringify(packets[1])};const reply=new Promise(resolve=>worker.onmessage=event=>resolve(event.data));worker.postMessage(packet);return JSON.stringify(await reply);}
      finally{worker.terminate();URL.revokeObjectURL(url);}
    })()`);
    if(workerResult!==JSON.stringify(packets[1]))throw new Error('Worker bootstrap swallowed an application message');
    const frames=page.frames(),root=frames.find(frame=>frame.parentFrame()===page.mainFrame()),nested=frames.find(frame=>frame.parentFrame()===root);
    const before=await nested.evaluate(()=>sandstone_frame.rpc.host.extra_targets.length);
    await root.evaluate(()=>{
      const channel=new MessageChannel();sandstone_frame.rpc.set_host(document.querySelector('iframe'),channel.port2,{nonce:'wrong-document'});channel.port1.close();
    });
    await page.waitForTimeout(30);
    if(await nested.evaluate(()=>sandstone_frame.rpc.host.extra_targets.length)!==before)throw new Error('A frame accepted an unauthorized bootstrap port');
    await root.evaluate(async url=>{
      const html=await(await fetch(url)).text();
      const nonce=JSON.parse(decodeURIComponent(html.match(/data-sandstone-bootstrap="([^"]+)"/)[1])).nonce;
      const channel=new MessageChannel();sandstone_frame.rpc.set_host(document.querySelector('iframe'),channel.port2,{nonce});channel.port1.close();
    },nested.url());
    await page.waitForTimeout(30);
    if(await nested.evaluate(()=>sandstone_frame.rpc.host.extra_targets.length)!==before)throw new Error('A live document accepted an additional bootstrap channel');
    return ['Application window and worker messages retain bootstrap-like payloads and transferred ports','Bootstrap probes stay private despite page event instrumentation','Bootstrap ports reject wrong document nonces and additional channels'];
  }finally{await evaluate('Event.prototype.stopImmediatePropagation=restoreBootstrapStop;true');}
}
