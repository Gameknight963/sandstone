async page=>{
  const origin='https://fixture.test',start=origin+'/iframe-window/start';
  const parent='<!doctype html><base href="/iframe-window/assets/"><body>Frame navigation';
  const child='<!doctype html><body>Child<script>window.childReady=true;parent.postMessage("frame-window-ready","*");<\/script>';
  const native=await page.context().newPage();
  await native.route('https://fixture.test/**',route=>route.fulfill({contentType:'text/html',body:route.request().url()===start?parent:child}));
  await native.route('https://other.test/**',route=>route.fulfill({contentType:'text/html',body:child}));
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const read=(proxy,source)=>evaluate(proxy,`JSON.stringify(${source})`).then(JSON.parse);
  const findChild=async(proxy,url)=>{
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){
      for(const frame of (proxy?page:native).frames())try{
        if(proxy?await frame.evaluate(url=>globalThis.sandstone_frame?.loader.url===url&&sandstone_frame.context.run_script('window.childReady===true'),url):frame.url()===url)return frame;
      }catch{}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    throw new Error('Frame window navigation timed out: '+url);
  };
  const run=async proxy=>{
    await evaluate(proxy,"globalThis.frameMessages=[];addEventListener('message',event=>{if(event.data==='frame-window-ready')frameMessages.push(event.source===child.contentWindow);});globalThis.child=document.createElement('iframe'); document.body.append(child); globalThis.savedWindow=child.contentWindow; true");
    const values=[];
    values.push(await read(proxy,"({detached:document.createElement('iframe').contentWindow,href:savedWindow.location.href,identity:savedWindow===savedWindow.window&&savedWindow===savedWindow.self&&savedWindow===savedWindow.frames,parent:savedWindow.parent===window,top:savedWindow.top===window})"));
    values.push(await read(proxy,`(()=>{
      const sandboxed=document.createElement('iframe');sandboxed.sandbox='allow-scripts';document.body.append(sandboxed);
      try{return sandboxed.contentWindow.location.href;}catch(error){return error.name;}finally{sandboxed.remove();}
    })()`));
    let initialHistory;
    const cases=[
      ["savedWindow.location.replace('first')",origin+'/iframe-window/assets/first'],
      ["savedWindow.location.href='second'",origin+'/iframe-window/assets/second'],
      ["savedWindow.location='third'",origin+'/iframe-window/assets/third'],
      ["savedWindow.location.replace('https://other.test/iframe-window/cross')",'https://other.test/iframe-window/cross'],
      ["savedWindow.location.replace('last')",origin+'/iframe-window/assets/last']
    ];
    for(const [action,url] of cases){
      await evaluate(proxy,action+'; true');
      const frame=await findChild(proxy,url);
      const history=proxy?await frame.evaluate(()=>sandstone_frame.context.run_script('history.length')):await frame.evaluate(()=>history.length);
      // Browsers expose joint session history; Sandstone stores child histories
      // separately. Compare the effects of pushes and replacements here.
      initialHistory??=history;
      values.push(await read(proxy,`(()=>{
        const attempt=callback=>{try{return callback();}catch(error){return error.name;}};
        return {src:child.src,raw:child.getAttribute('src'),has:child.hasAttribute('src'),identity:savedWindow===child.contentWindow,
          href:attempt(()=>savedWindow.location.href),assign:attempt(()=>typeof savedWindow.location.assign),replace:typeof savedWindow.location.replace,history:${history-initialHistory}};
      })()`));
    }
    const deadline=Date.now()+5000;
    while(await evaluate(proxy,'frameMessages.length')<5&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
    values.push(await read(proxy,'frameMessages'));
    for(const action of ["child.src='authored'","savedWindow.location.replace('replacement')"]){
      await evaluate(proxy,action+'; true');
      await findChild(proxy,origin+'/iframe-window/assets/'+(action.includes('authored')?'authored':'replacement'));
      values.push(await read(proxy,'({src:child.src,raw:child.getAttribute("src"),has:child.hasAttribute("src"),location:String(savedWindow.location)})'));
    }
    return values;
  };
  try{
    await native.goto(start);const expected=await run(false);
    await page.evaluate(async({start,parent,child})=>{
      const previous=sandstone.network.session.fetch;globalThis.frameWindowRequests=[];
      sandstone.network.session.fetch=(url,options)=>{
        if(!new URL(url).pathname.startsWith('/iframe-window/'))return previous(url,options);
        frameWindowRequests.push(url);
        return Promise.resolve(new Response(url===start?parent:child,{headers:{'Content-Type':'text/html'}}));
      };
      await main_frame.navigate_to(start);
    },{start,parent,child});
    const actual=await run(true);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Frame window parity: '+JSON.stringify({expected,actual}));
    const requests=await page.evaluate(()=>frameWindowRequests);
    if(requests.length!==8)throw new Error('Frame window requests escaped the relay: '+JSON.stringify(requests));
    return ['Frame window assign, href and replace use the relay', 'Frame location origin restrictions and stable window identity', 'Frame navigation preserves src attributes and replace history'];
  }finally{await native.close();}
}
