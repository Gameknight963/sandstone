async page=>{
  const origin='https://fixture.test',start=origin+'/iframe-window/start';
  const parent='<!doctype html><base href="/iframe-window/assets/"><body>Frame navigation';
  const child='<!doctype html><body>Child<script>window.childReady=true;parent.postMessage("frame-window-ready","*");<\/script>';
  const native=await page.context().newPage();
  await native.route('https://fixture.test/**',route=>route.fulfill({contentType:'text/html',body:route.request().url()===start?parent:child}));
  await native.route('https://other.test/**',route=>route.fulfill({contentType:'text/html',body:child}));
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const read=(proxy,source)=>evaluate(proxy,`JSON.stringify(${source})`).then(JSON.parse);
  const bounded=async(operation,label,ms=1000)=>{
    let timer;
    try{return await Promise.race([operation,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error(label+' did not respond')),ms))]);}
    finally{clearTimeout(timer);}
  };
  const findChild=async(proxy,url)=>{
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){
      for(const frame of (proxy?page:native).frames())try{
        if(!proxy&&frame.url()!==url)continue;
        const ready=await bounded(frame.evaluate(({proxy,url})=>proxy?
          globalThis.sandstone_frame?.loader.url===url&&sandstone_frame.context.run_script('window.childReady===true'):
          location.href===url&&globalThis.childReady===true,{proxy,url}),'Frame readiness',250);
        if(ready)return frame;
      }catch{}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const frames=await Promise.all((proxy?page:native).frames().map(async frame=>{
      try{return await bounded(frame.evaluate(()=>({physical:location.href,virtual:globalThis.sandstone_frame?.loader.url,ready:globalThis.sandstone_frame?.context.run_script('window.childReady===true')})),'Frame diagnostics');}
      catch(error){return {physical:frame.url(),error:error.message};}
    }));
    throw new Error('Frame window navigation timed out: '+JSON.stringify({proxy,url,frames,requests:proxy?await page.evaluate(()=>frameWindowRequests):undefined}));
  };
  const run=async proxy=>{
    console.log(JSON.stringify({fixture:'Frame window',proxy,step:'create child'}));
    await evaluate(proxy,"globalThis.frameMessages=[];addEventListener('message',event=>{if(event.data==='frame-window-ready')frameMessages.push(event.source===child.contentWindow);});globalThis.child=document.createElement('iframe');child.name='relayChild';document.body.append(child);globalThis.savedWindow=frames[0];true");
    const values=[];
    values.push(await read(proxy,"({detached:document.createElement('iframe').contentWindow,href:savedWindow.location.href,identity:savedWindow===savedWindow.window&&savedWindow===savedWindow.self&&savedWindow===savedWindow.frames,parent:savedWindow.parent===window,top:savedWindow.top===window,indexed:frames[0]===child.contentWindow&&window[0]===savedWindow,named:window.relayChild===savedWindow&&frames.relayChild===savedWindow})"));
    values.push(await read(proxy,`(()=>{
      const sandboxed=document.createElement('iframe');sandboxed.name='opaqueNamed';sandboxed.sandbox='allow-scripts';document.body.append(sandboxed);
      const named=frames.opaqueNamed===sandboxed.contentWindow;sandboxed.name='changedOpaque';
      try{return sandboxed.contentWindow.location.href;}catch(error){return {access:error.name,named,oldName:typeof window.opaqueNamed};}finally{sandboxed.remove();}
    })()`));
    let initialHistory;
    const cases=[
      ["savedWindow.location.replace('first')",origin+'/iframe-window/assets/first'],
      ["frames[0].location.href='second'",origin+'/iframe-window/assets/second'],
      ["window.relayChild.location='third'",origin+'/iframe-window/assets/third'],
      ["frames.relayChild.location.replace('https://other.test/iframe-window/cross')",'https://other.test/iframe-window/cross'],
      ["window[0].location.replace('last')",origin+'/iframe-window/assets/last']
    ];
    for(const [action,url] of cases){
      console.log(JSON.stringify({fixture:'Frame window',proxy,step:action}));
      await evaluate(proxy,action+'; true');
      const frame=await findChild(proxy,url);
      const history=await bounded(proxy?frame.evaluate(()=>sandstone_frame.context.run_script('history.length')):frame.evaluate(()=>history.length),'Child history',5000);
      // Browsers expose joint session history; Sandstone stores child histories
      // separately. Compare the effects of pushes and replacements here.
      initialHistory??=history;
      values.push(await read(proxy,`(()=>{
        const attempt=callback=>{try{return callback();}catch(error){return error.name;}};
        return {src:child.src,raw:child.getAttribute('src'),has:child.hasAttribute('src'),identity:savedWindow===child.contentWindow,
          href:attempt(()=>savedWindow.location.href),assign:attempt(()=>typeof savedWindow.location.assign),replace:typeof savedWindow.location.replace,history:${history-initialHistory}};
      })()`));
      if(new URL(url).origin!==origin){
        values.push(await read(proxy,`(()=>{
          child.name='changedCross';
          const result={oldName:typeof window.relayChild,newName:typeof window.changedCross};
          child.name='relayChild';return result;
        })()`));
      }
    }
    const deadline=Date.now()+5000;
    while(await evaluate(proxy,'frameMessages.length')<5&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
    values.push(await read(proxy,'frameMessages'));
    for(const action of ["child.src='authored'","savedWindow.location.replace('replacement')"]){
      console.log(JSON.stringify({fixture:'Frame window',proxy,step:action}));
      await evaluate(proxy,action+'; true');
      await findChild(proxy,origin+'/iframe-window/assets/'+(action.includes('authored')?'authored':'replacement'));
      values.push(await read(proxy,'({src:child.src,raw:child.getAttribute("src"),has:child.hasAttribute("src"),location:String(savedWindow.location)})'));
    }
    values.push(await read(proxy,`(()=>{
      child.name='renamedChild';
      const other=document.createElement('iframe');other.name='otherChild';child.before(other);
      const reordered={length:frames.length,first:frames[0]===other.contentWindow,second:frames[1]===savedWindow,renamed:frames.renamedChild===savedWindow,other:window.otherChild===other.contentWindow,old:typeof window.relayChild};
      other.remove();
      const removed=frames.length===1&&frames[0]===savedWindow&&frames[1]===undefined&&window.otherChild===undefined;
      const numeric=document.createElement('iframe');numeric.name='99';document.body.append(numeric);
      const numericName=frames[99]===undefined;numeric.remove();
      return {reordered,removed,numericName};
    })()`));
    const namedFrame=await findChild(proxy,origin+'/iframe-window/assets/replacement');
    values.push(await (proxy?namedFrame.evaluate(()=>sandstone_frame.context.run_script('window.name="scriptName";name')):namedFrame.evaluate(()=>window.name='scriptName')));
    const nameDeadline=Date.now()+5000;
    while(!await evaluate(proxy,'frames.scriptName===savedWindow')){
      if(Date.now()>nameDeadline)throw new Error('Script-assigned frame name did not update');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    values.push(await read(proxy,`(()=>{
      window.scriptName=undefined;
      const shadowed=frames.scriptName===undefined;
      delete window.scriptName;
      return {shadowed,restored:frames.scriptName===savedWindow};
    })()`));
    values.push(await read(proxy,`(()=>{
      const duplicate=document.createElement('iframe');duplicate.name='scriptName';child.before(duplicate);duplicate.name='differentAttribute';
      const first=frames.scriptName===savedWindow;duplicate.remove();return first;
    })()`));
    await evaluate(proxy,"frames.scriptName.location.replace('after-name');true");
    const renamedFrame=await findChild(proxy,origin+'/iframe-window/assets/after-name');
    values.push(await (proxy?renamedFrame.evaluate(()=>sandstone_frame.context.run_script('name')):renamedFrame.evaluate(()=>name)));
    values.push(await evaluate(proxy,'frames.scriptName===savedWindow'));
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
    if(requests.length!==9)throw new Error('Frame window requests escaped the relay: '+JSON.stringify(requests));
    return ['Frame window assign, href and replace use the relay', 'Frame location origin restrictions and stable window identity', 'Frame navigation preserves src attributes and replace history','Indexed/named frames share contentWindow identity and relayed navigation','Frame indices and names follow insertion, renaming and removal','Script-assigned browsing-context names survive navigation and respect global property overrides'];
  }finally{await native.close();}
}
