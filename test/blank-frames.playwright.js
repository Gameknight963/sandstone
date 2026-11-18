async page=>{
  const origin='https://blank-frames.test',start=origin+'/parent',html='<!doctype html><base href="/assets/"><body>Blank frames';
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage(),nativeBeacons=[];
  const response=async(url,method,body,headers)=>{
    const path=new URL(url).pathname;
    if(path.endsWith('/echo')){
      const result={url,method,body,origin:headers.get('origin'),referrer:headers.get('referer')};
      if(body==='unwritten-beacon')nativeBeacons.push(result);
      return {type:'application/json',body:JSON.stringify(result)};
    }
    if(path.endsWith('/dependency.js'))return {type:'text/javascript',body:'globalThis.remoteScript="loaded";'};
    if(path.endsWith('/pixel.svg'))return {type:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"/>'};
    return {type:'text/html',body:html};
  };
  await nativeContext.route(origin+'/**',async route=>{const request=route.request(),result=await response(request.url(),request.method(),request.postData()||'',new Headers(request.headers()));await route.fulfill({contentType:result.type,body:result.body});});
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const run=async proxy=>{
    if(proxy)await page.evaluate(async({start,html})=>{main_frame.special_pages[start]=html;await main_frame.navigate_to(start);},{start,html});else await native.goto(start);
    const basic=JSON.parse(await evaluate(proxy,`(async()=>{
      document.cookie='initial=visible; Path=/';localStorage.setItem('blank-fixture','stored');sessionStorage.setItem('blank-session','session');
      const results=[];
      for(const source of [null,'','about:blank','about:blank#fragment']){
        const frame=document.createElement('iframe');if(source!==null)frame.src=source;
        const loads=[];frame.addEventListener('load',()=>loads.push(frame.contentDocument?.title||''));document.body.append(frame);
        const doc=frame.contentDocument,win=frame.contentWindow;
        const initial={url:doc.URL,base:doc.baseURI,origin:win.origin,location:win.location.href,body:doc.body.tagName,mode:doc.compatMode,cookie:doc.cookie,
          local:win.localStorage.getItem('blank-fixture'),session:win.sessionStorage.getItem('blank-session'),src:frame.getAttribute('src')};
        doc.open();doc.write('<!doctype html><title>Written</title><body><p id="value">written</p><script>globalThis.fromBlank=41+1;<\\/script>');doc.close();
        results.push({initial,written:{url:doc.URL,base:doc.baseURI,location:win.location.href,text:doc.getElementById('value').textContent,value:win.fromBlank,identity:doc===win.document,loads}});
        frame.remove();
      }
      return JSON.stringify(results);
    })()`));
    const unwrittenXHR=JSON.parse(await evaluate(proxy,`(async()=>{
      const frame=document.createElement('iframe');document.body.append(frame);
      try{
        const xhr=new frame.contentWindow.XMLHttpRequest();xhr.open('POST','echo');
        const response=new Promise((resolve,reject)=>{xhr.onload=()=>resolve(xhr.responseText);xhr.onerror=()=>reject(new Error('Unwritten blank XHR failed'));});
        if(!frame.contentWindow.navigator.sendBeacon('echo','unwritten-beacon'))throw new Error('Unwritten blank beacon was rejected');
        xhr.send('unwritten-xhr');return await response;
      }finally{frame.remove();}
    })()`));
    let unwrittenBeacon;const beaconDeadline=Date.now()+5000;
    while(!(unwrittenBeacon=proxy?await page.evaluate(()=>globalThis.blankFrameBeacons[0]):nativeBeacons[0])){
      if(Date.now()>beaconDeadline)throw new Error('Unwritten blank beacon did not finish');await new Promise(resolve=>setTimeout(resolve,10));
    }
    const nested=JSON.stringify('<script>globalThis.nestedValue=84;<\/script>').replace(/</g,'\\u003c');
    const asyncHTML='<!doctype html><base href="/assets/"><body><img id="pixel" src="pixel.svg"><script src="dependency.js"><\/script><script>'+`localStorage.setItem('blank-pending','saved');history.replaceState({written:true},'','/written-state');globalThis.blankFetch=fetch('echo',{method:'POST',body:'blank-body'}).then(response=>response.json());const nested=document.createElement('iframe');document.body.append(nested);nested.contentDocument.write(${nested});nested.contentDocument.close();globalThis.nestedResult=nested.contentWindow.nestedValue;globalThis.blankWorker=new Worker(URL.createObjectURL(new Blob(['onmessage=event=>postMessage(event.data+1);'],{type:'text/javascript'})));globalThis.workerReply=new Promise(resolve=>blankWorker.onmessage=event=>resolve(event.data));blankWorker.postMessage(8);`+'<\/script>';
    const asynchronous=JSON.parse(await evaluate(proxy,`(async()=>{
      const frame=document.createElement('iframe'),loads=[];frame.onload=()=>loads.push('load');document.body.append(frame);
      const doc=frame.contentDocument,win=frame.contentWindow,beforeFetch=win.fetch('echo',{method:'POST',body:'before-write'}).then(response=>response.json());doc.open();doc.write(${JSON.stringify(asyncHTML)});doc.close();
      const deadline=Date.now()+8000;while(!win.blankFetch||!doc.getElementById('pixel')?.complete||loads.length<2){if(Date.now()>deadline)throw new Error('Written blank resources did not finish');await new Promise(resolve=>setTimeout(resolve,10));}
      const fetch=await win.blankFetch,worker=await win.workerReply;win.blankWorker.terminate();
      const result={before:await beforeFetch,fetch,worker,nested:win.nestedResult,script:win.remoteScript,pixel:doc.getElementById('pixel').naturalWidth,storage:win.localStorage.getItem('blank-pending'),history:win.history.state,loads};
      frame.remove();return JSON.stringify(result);
    })()`));
    const lifecycle=JSON.parse(await evaluate(proxy,`(async()=>{
      const frame=document.createElement('iframe');document.body.append(frame);const first=frame.contentWindow;
      frame.contentDocument.write('<script>globalThis.oldBlank=true;<\\/script>');frame.contentDocument.close();
      frame.src='about:blank';const doc=frame.contentDocument;doc.open();doc.write('<!doctype html><title>Reset</title><body id="reset">Reset');doc.close();
      await new Promise(resolve=>setTimeout(resolve,30));
      const reset={title:frame.contentDocument.title,body:frame.contentDocument.body.id,url:frame.contentDocument.URL};
      frame.remove();document.body.append(frame);const reinserted={fresh:frame.contentWindow!==first,old:typeof frame.contentWindow.oldBlank,url:frame.contentDocument?.URL||null};frame.remove();
      const sandbox=[];
      for(const tokens of ['allow-same-origin','allow-scripts allow-same-origin','allow-scripts']){
        const child=document.createElement('iframe');child.sandbox=tokens;document.body.append(child);const doc=child.contentDocument;
        if(doc){doc.write('<script>globalThis.allowedBlank=true;<\\/script>');doc.close();}
        sandbox.push({tokens:child.getAttribute('sandbox'),accessible:!!doc,script:doc?child.contentWindow.allowedBlank===true:false});child.remove();
      }
      return JSON.stringify({reset,reinserted,sandbox});
    })()`));
    return {basic,unwrittenXHR,unwrittenBeacon,asynchronous,lifecycle};
  };
  try{
    const expected=await run(false);
    await page.evaluate(origin=>{
      globalThis.blankFrameBeacons=[];
      const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=async(url,options)=>{
        if(new URL(url).origin!==origin)return previous(url,options);
        const path=new URL(url).pathname;
        if(path.endsWith('/echo')){
          const result={url,method:options.method||'GET',body:await new Response(options.body).text(),origin:new Headers(options.headers).get('origin'),referrer:new Headers(options.headers).get('referer')};
          if(result.body==='unwritten-beacon')blankFrameBeacons.push(result);
          return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}});
        }
        if(path.endsWith('/dependency.js'))return new Response('globalThis.remoteScript="loaded";',{headers:{'Content-Type':'text/javascript'}});
        if(path.endsWith('/pixel.svg'))return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"/>',{headers:{'Content-Type':'image/svg+xml'}});
        return previous(url,options);
      };
    },origin);
    const actual=await run(true);
    if(JSON.stringify(actual)!==JSON.stringify(expected)){console.log(JSON.stringify({blankFrames:{expected,actual}}));throw new Error('Blank frames differ from native');}
    const deadline=Date.now()+5000;
    while(!await page.evaluate(()=>Object.keys(sandstone.controller.iframes).length===1)){if(Date.now()>deadline)throw new Error('Removed blank frame registrations remain active');await new Promise(resolve=>setTimeout(resolve,20));}
    return ['Fresh blank frames initialize synchronously with inherited document, cookie and storage metadata','Immediate blank-frame document writes execute through the runtime and preserve native load behavior','Written blank frames relay scripts, images, fetch and workers while nested blanks initialize before registration replies','Blank resets, reinsertion and script/origin sandboxing preserve native behavior','Removing blank frames before registration completes releases their host contexts'];
  }finally{await nativeContext.close();}
}
