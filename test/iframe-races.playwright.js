async page=>{
  const evaluate=source=>page.evaluate(source=>main_frame.eval_js(source),source);
  const read=source=>evaluate(`JSON.stringify(${source})`).then(JSON.parse);
  const until=async predicate=>{
    const deadline=Date.now()+10000;
    while(!await predicate()){
      if(Date.now()>deadline)throw new Error('Iframe race fixture timed out');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  };
  await page.evaluate(async()=>{
    const previous=sandstone.network.session.fetch;
    globalThis.iframeRace={requests:[],gates:{},signals:{}};
    sandstone.network.session.fetch=async(url,options)=>{
      const path=new URL(url).pathname;
      if(!path.startsWith('/iframe-races/'))return previous(url,options);
      iframeRace.requests.push(path);iframeRace.signals[path]=options.signal;
      if(path.endsWith('/slow')||path.endsWith('/hang.js'))await new Promise(resolve=>iframeRace.gates[path]=resolve);
      const html=path.endsWith('/start')?'<!doctype html><body>Parent':
        path.endsWith('/script')?'<!doctype html><script src="/iframe-races/hang.js"></script><body>Old script':
        '<!doctype html><body>'+path+'<script>parent.postMessage({kind:"race-ready",path:location.pathname},"*");<\/script>';
      return new Response(path.endsWith('.js')?'window.oldScriptFinished=true;':html,{headers:{'Content-Type':path.endsWith('.js')?'application/javascript':'text/html'}});
    };
    await main_frame.navigate_to('https://fixture.test/iframe-races/start');
  });
  await evaluate(`globalThis.arrivals=[];addEventListener('message',event=>{if(event.data?.kind==='race-ready')arrivals.push(event.data.path);});
    globalThis.child=document.createElement('iframe');document.body.append(child);true`);
  const ready=path=>until(async()=>await evaluate('arrivals.includes('+JSON.stringify('/iframe-races/'+path)+')'));
  await evaluate("child.src='/iframe-races/slow';true");
  await until(()=>page.evaluate(()=>!!iframeRace.gates['/iframe-races/slow']));
  await evaluate("child.src='/iframe-races/fast';true");await ready('fast');
  if(!await page.evaluate(()=>iframeRace.signals['/iframe-races/slow']?.aborted))throw new Error('The superseded iframe fetch was not aborted');
  await page.evaluate(()=>iframeRace.gates['/iframe-races/slow']());
  await page.waitForTimeout(50);
  if(await evaluate("arrivals.includes('/iframe-races/slow')"))throw new Error('A stale iframe response replaced the new document');
  const root=page.frames().find(frame=>frame.parentFrame()===page.mainFrame());
  await root.evaluate(()=>{
    const rpc=sandstone_frame.rpc,post=rpc.host.postMessage;
    globalThis.registrationRace={};
    rpc.host.postMessage=function(message,...args){
      if(message.procedure==='frame_register'&&message.arguments[2].endsWith('/register')){
        const callback=rpc.rpc_requests[message.id];
        rpc.rpc_requests[message.id]=reply=>{
          registrationRace.waiting=true;registrationRace.release=()=>callback(reply);
        };
      }
      return Reflect.apply(post,this,[message,...args]);
    };
  });
  await evaluate("child.src='/iframe-races/register';true");
  await until(()=>root.evaluate(()=>!!registrationRace.waiting));
  await evaluate("child.src='/iframe-races/after-register';true");
  await until(()=>page.evaluate(()=>iframeRace.requests.includes('/iframe-races/after-register')));
  await root.evaluate(()=>registrationRace.release());await ready('after-register');
  await evaluate("child.src='/iframe-races/script';true");
  await until(()=>page.evaluate(()=>!!iframeRace.gates['/iframe-races/hang.js']));
  await evaluate("child.src='/iframe-races/after-script';true");await ready('after-script');
  await page.evaluate(()=>iframeRace.gates['/iframe-races/hang.js']());
  await page.waitForTimeout(50);
  const arrivals=await read('arrivals');
  if(JSON.stringify(arrivals)!==JSON.stringify(['/iframe-races/fast','/iframe-races/after-register','/iframe-races/after-script']))throw new Error('Unexpected iframe race arrivals: '+JSON.stringify(arrivals));
  await page.evaluate(()=>{delete iframeRace.gates['/iframe-races/slow'];});
  await evaluate("child.src='/iframe-races/slow';true");
  await until(()=>page.evaluate(()=>!!iframeRace.gates['/iframe-races/slow']));
  await evaluate("child.src='';true");
  await page.evaluate(()=>iframeRace.gates['/iframe-races/slow']());
  await page.waitForTimeout(50);
  if(await evaluate("arrivals.includes('/iframe-races/slow')"))throw new Error('Resetting a frame failed to cancel its pending navigation');
  return ['Superseded iframe fetches and blank resets cannot install stale documents', 'Iframe registration replies serialize across overlapping navigations', 'Iframe navigation cancels a pending document RPC without waiting for old scripts'];
}
