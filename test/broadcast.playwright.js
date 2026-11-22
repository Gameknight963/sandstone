async page=>{
  const origin='https://fixture.test',other='https://other.test',start=origin+'/broadcast/parent';
  const parent='<!doctype html><body>Broadcast channels';
  const child='<!doctype html><body>Channel peer<script>window.peerChannel=new BroadcastChannel("site-coordination");peerChannel.onmessage=event=>parent.postMessage({kind:"broadcast-result",id:location.hostname,path:location.pathname+location.search,data:event.data,origin:event.origin,trusted:event.isTrusted},"*");parent.postMessage({kind:"broadcast-ready",id:location.hostname},"*");'+
    `if(location.hostname==='other.test'){addEventListener('message',event=>{if(event.data?.kind?.startsWith('broadcast-'))parent.postMessage(event.data,'*');});const nested=document.createElement('iframe');nested.src='${origin}/broadcast/grandchild';document.body.append(nested);}`+'<\/script>';
  const worker=`const channel=new BroadcastChannel('worker-sync');channel.onmessage=async event=>{
    const key=event.data.key,signature=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('message'));
    channel.postMessage({origin:event.origin,trusted:event.isTrusted,key:key instanceof CryptoKey,extractable:key.extractable,signature:Array.from(new Uint8Array(signature))});
  };postMessage('ready');`;
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage();
  for(const host of [origin,other])await nativeContext.route(host+'/broadcast/**',route=>{
    const url=route.request().url(),script=/\.m?js$/.test(url);
    return route.fulfill({contentType:script?'text/javascript':'text/html',body:script?worker:url===start||url.endsWith('/after')?parent:child});
  });
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const read=(proxy,source)=>evaluate(proxy,'JSON.stringify('+source+')').then(JSON.parse);
  const until=async(proxy,expression)=>{
    const deadline=Date.now()+5000;
    while(!await evaluate(proxy,expression)){
      if(Date.now()>deadline)throw new Error('Broadcast fixture timed out: '+expression);
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  };
  const run=async proxy=>{
    if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),start);else await native.goto(start);
    const local=JSON.parse(await evaluate(proxy,`(async()=>JSON.stringify(await new Promise((resolve,reject)=>{
      const sender=new BroadcastChannel('clone-test'),receiver=new BroadcastChannel('clone-test'),wrong=new BroadcastChannel('other-name');
      const events=[];sender.onmessage=()=>events.push('self');wrong.onmessage=()=>events.push('wrong');
      const timer=setTimeout(()=>reject(new Error('Local channel did not deliver')),3000);
      const original={text:'snapshot',bytes:new Uint8Array([1,2,3]),date:new Date(42)};
      EventTarget.prototype.addEventListener.call(receiver,'message',function(event){events.push(this===receiver&&event.target===receiver&&event.currentTarget===receiver?'native-listener':'bad-target');},{once:true});
      receiver.onmessage=event=>{
        clearTimeout(timer);const result={name:receiver.name,instance:receiver instanceof BroadcastChannel,tag:Object.prototype.toString.call(receiver),origin:event.origin,source:event.source,trusted:event.isTrusted,
          data:{text:event.data.text,bytes:Array.from(event.data.bytes),date:event.data.date.getTime()},events};
        sender.close();receiver.close();wrong.close();
        try{sender.postMessage('closed');}catch(error){result.closed=error.name;}
        resolve(result);
      };
      try{sender.postMessage(()=>{});}catch(error){events.push(error.name);}
      sender.postMessage(original);original.text='changed';original.bytes.fill(9);
    })))()`));
    await evaluate(proxy,`window.channelArrivals=[];window.channelReady=[];
      addEventListener('message',event=>{if(event.data?.kind==='broadcast-ready')channelReady.push(event.data.id);if(event.data?.kind==='broadcast-result')channelArrivals.push(event.data);});
      for(const [host,opaque] of ${JSON.stringify([[origin,false],[other,false],[origin,true]])}){const frame=document.createElement('iframe');if(opaque)frame.sandbox='allow-scripts';frame.src=host+'/broadcast/child'+(opaque?'?opaque=1':'');document.body.append(frame);}
      window.rootChannel=new BroadcastChannel('site-coordination');true`);
    await until(proxy,'channelReady.length===4');
    await evaluate(proxy,'rootChannel.postMessage({text:"same-origin only"});true');
    await until(proxy,'channelArrivals.length>=1');
    // A wrong-origin channel must remain silent after all delivery tasks run.
    await evaluate(proxy,'new Promise(resolve=>setTimeout(resolve,100))');
    const peers=await read(proxy,'channelArrivals.slice().sort((a,b)=>a.path.localeCompare(b.path))');
    await evaluate(proxy,'rootChannel.close();true');
    const workers=[];
    for(const type of ['classic','module']){
      console.log(JSON.stringify({fixture:'Broadcast worker',proxy,type}));
      workers.push(JSON.parse(await evaluate(proxy,`(async()=>{
        const channel=new BroadcastChannel('worker-sync'),worker=new Worker(${JSON.stringify(origin+'/broadcast/worker.')}+${JSON.stringify(type==='module'?'mjs':'js')},{type:${JSON.stringify(type)}});
        try{
          await new Promise((resolve,reject)=>{worker.onmessage=()=>resolve();worker.onerror=event=>reject(new Error(event.message));});
          const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('secret'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
          return JSON.stringify(await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(new Error('Worker channel did not deliver (${proxy?'proxy':'native'} ${type})')),5000);
            channel.onmessage=event=>{clearTimeout(timer);resolve({...event.data,responseOrigin:event.origin,responseTrusted:event.isTrusted});};
            channel.postMessage({key});
          }));
        }finally{channel.close();worker.terminate();}
      })()`)));
    }
    const tab=proxy?await page.context().newPage():await nativeContext.newPage();
    let tabs;
    try{
      if(proxy){
        await tab.route(/^https?:/,route=>route.abort('blockedbyclient'));
        await tab.goto(page.url());
        await tab.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
        await tab.evaluate(async({start,parent})=>{main_frame.special_pages[start]=parent;await main_frame.navigate_to(start);},{start,parent});
      }else await tab.goto(start);
      const setup=`window.tabChannel=new BroadcastChannel('tab-coordination');tabChannel.onmessage=async event=>{
        const signature=await crypto.subtle.sign('HMAC',event.data.key,new TextEncoder().encode('tabs'));
        tabChannel.postMessage({origin:event.origin,trusted:event.isTrusted,key:event.data.key instanceof CryptoKey,signature:Array.from(new Uint8Array(signature))});
      };true`;
      if(proxy)await tab.evaluate(source=>main_frame.eval_js(source),setup);else await tab.evaluate(source=>eval(source),setup);
      tabs=JSON.parse(await evaluate(proxy,`(async()=>{
        const channel=new BroadcastChannel('tab-coordination');
        try{
          const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('secret'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
          return JSON.stringify(await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(new Error('Cross-tab channel did not deliver')),5000);
            channel.onmessage=event=>{clearTimeout(timer);resolve({...event.data,responseOrigin:event.origin,responseTrusted:event.isTrusted});};
            channel.postMessage({key});
          }));
        }finally{channel.close();}
      })()`));
    }finally{await tab.close();}
    return {local,peers,workers,tabs};
  };
  try{
    const expected=await run(false);
    await page.evaluate(({start,parent,child,worker})=>{
      const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=(url,options)=>{
        if(!new URL(url).pathname.startsWith('/broadcast/'))return previous(url,options);
        const script=/\.m?js$/.test(url);
        return Promise.resolve(new Response(script?worker:url===start||url.endsWith('/after')?parent:child,{headers:{'Content-Type':script?'text/javascript':'text/html'}}));
      };
    },{start,parent,child,worker});
    const actual=await run(true);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Broadcast channel parity: '+JSON.stringify({expected,actual}));
    await page.evaluate(url=>main_frame.navigate_to(url),origin+'/broadcast/after');
    if(await page.evaluate(()=>sandstone.network.broadcast_channels.channels.size)!==0)throw new Error('Broadcast channels survived document retirement');
    return ['BroadcastChannel preserves native cloning, names, close errors and trusted message events','BroadcastChannel virtual origins isolate cross-site frames while same-origin frames communicate','Classic/module workers and separate file-host tabs exchange nonextractable CryptoKeys through BroadcastChannel','Broadcast channels close when their documents and workers retire'];
  }finally{await nativeContext.close();}
}
