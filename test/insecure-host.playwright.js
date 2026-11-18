async(page,artifact)=>{
  const host=await page.context().newPage(),url='http://insecure-proxy.test/';
  const errors=[];host.on('pageerror',error=>errors.push(error.message));
  try{
    await host.route(url+'**',route=>route.fulfill({contentType:'text/html',body:artifact}));
    await host.goto(url);
    const capabilities=await host.evaluate(()=>({secure:isSecureContext,uuid:typeof crypto.randomUUID,random:typeof crypto.getRandomValues}));
    if(capabilities.secure||capabilities.uuid!=='undefined'||capabilities.random!=='function')throw new Error('The insecure bootstrap fixture was not an insecure context: '+JSON.stringify(capabilities));
    await host.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await host.evaluate(async()=>{
      main_frame.on_load=()=>{};
      const url='https://insecure-bootstrap.test/';
      main_frame.special_pages[url]=`<!doctype html><body><script>globalThis.bootReady=true;globalThis.inlineReady=false;addEventListener('message',event=>{if(event.data==='inline-ready')inlineReady=true;});</script><iframe srcdoc="&lt;script&gt;parent.postMessage('inline-ready','*')&lt;/script&gt;"></iframe>`;
      await main_frame.navigate_to(url);
    });
    await host.waitForFunction(()=>main_frame.eval_js('globalThis.bootReady&&globalThis.inlineReady'));
    const worker=await host.evaluate(()=>main_frame.eval_js(`(async()=>{
      const url=URL.createObjectURL(new Blob(['onmessage=event=>postMessage(event.data);'],{type:'text/javascript'})),worker=new Worker(url);
      try{const reply=new Promise(resolve=>worker.onmessage=event=>resolve(event.data));worker.postMessage('worker-ready');return await reply;}
      finally{worker.terminate();URL.revokeObjectURL(url);}
    })()`));
    if(worker!=='worker-ready')throw new Error('An insecure host could not bootstrap a worker');
    if(errors.length)throw new Error('Insecure bootstrap errors: '+JSON.stringify(errors));
    return ['Insecure HTTP hosts bootstrap pages, inline frames and workers without randomUUID'];
  }finally{await host.close();}
}
