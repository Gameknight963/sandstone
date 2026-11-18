async page=>{
  await page.evaluate(async()=>{
    const old='https://fixture.test/readiness/old',first='https://fixture.test/readiness/first',last='https://fixture.test/readiness/last';
    for(const url of [old,first,last])main_frame.special_pages[url]='<!doctype html><title>'+new URL(url).pathname+'</title><body>Runtime readiness';
    await main_frame.navigate_to(old);
    const frame=main_frame.iframe,property=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'src');
    const previous=Object.getOwnPropertyDescriptor(frame,'src'),send=main_frame.send_page;
    let logical=frame.src;
    globalThis.runtimeGate={old,first,last,held:[],sent:[],before:logical,restore(){
      if(previous)Object.defineProperty(frame,'src',previous);else delete frame.src;
      main_frame.send_page=send;
    }};
    Object.defineProperty(frame,'src',{configurable:true,get(){return logical;},set(value){
      logical=value;if(value.startsWith('blob:')){property.set.call(frame,value);return;}runtimeGate.held.push({url:value,release:()=>property.set.call(frame,value)});
    }});
    main_frame.send_page=function(options){runtimeGate.sent.push(options.url);return Reflect.apply(send,this,[options]);};
    main_frame.navigate_to(first).then(()=>runtimeGate.firstDone=true);
  });
  try{
    await page.waitForFunction(()=>runtimeGate.held.length===1);
    // The old runtime is alive and receives the new readiness probes. It must
    // not authorize initialization of a document that has not been installed.
    await page.waitForTimeout(100);
    let state=await page.evaluate(()=>({loading:main_frame.is_navigating,sent:runtimeGate.sent}));
    if(!state.loading||state.sent.length)throw new Error('An old runtime authorized a new document: '+JSON.stringify(state));
    await page.evaluate(()=>{main_frame.navigate_to(runtimeGate.last).then(()=>runtimeGate.lastDone=true);});
    await page.waitForFunction(()=>runtimeGate.held.length===2&&runtimeGate.firstDone);
    const urls=await page.evaluate(()=>[runtimeGate.before,...runtimeGate.held.map(item=>item.url)]);
    if(new Set(urls).size!==3)throw new Error('Successive runtime documents reused their readiness identity: '+JSON.stringify(urls));
    await page.evaluate(()=>runtimeGate.held.at(-1).release());
    await page.waitForFunction(()=>runtimeGate.lastDone&&!main_frame.is_navigating);
    state=await page.evaluate(()=>({sent:runtimeGate.sent,last:runtimeGate.last}));
    if(JSON.stringify(state.sent)!==JSON.stringify([state.last]))throw new Error('A superseded document received initialization: '+JSON.stringify(state));
    const title=await page.evaluate(()=>main_frame.eval_js('document.title'));
    if(title!=='/readiness/last')throw new Error('The latest runtime did not receive its document: '+title);
    return ['Runtime readiness cannot be satisfied by the previous document', 'Superseded readiness waits cancel before the next runtime is installed'];
  }finally{await page.evaluate(()=>runtimeGate.restore());}
}
