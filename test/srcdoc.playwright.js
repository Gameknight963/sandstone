async page=>{
  const origin='https://srcdoc.test',start=origin+'/parent/page';
  const context=await page.context().browser().newContext(),native=await context.newPage();
  const parent='<!doctype html><base href="/assets/"><body>Inline frame fixture';
  const external='globalThis.externalInline=true;';
  const workerCode='postMessage({url:location.href,origin:location.origin});';
  const code=`(async()=>{
    const attempt=fn=>{try{return fn();}catch(error){return error.name;}};
    const snapshot=async()=>({url:location.href,docURL:document.URL,locOrigin:location.origin,origin,
      base:document.baseURI,referrer:document.referrer,cookie:attempt(()=>document.cookie),
      storage:attempt(()=>localStorage.shared),external:globalThis.externalInline,
      indexedDB:attempt(()=>typeof indexedDB),cache:attempt(()=>typeof caches),
      database:attempt(()=>{const request=indexedDB.open('inline-probe');request.onsuccess=()=>request.result.close();request.onerror=event=>event.preventDefault();return 'pending';}),
      fetch:await(await fetch('echo',{method:'POST'})).json(),
      worker:origin==='null'?'blocked':await new Promise((resolve,reject)=>{const worker=new Worker('worker.js');worker.onmessage=event=>{worker.terminate();resolve(event.data);};worker.onerror=reject;})});
    parent.postMessage({kind:'inline-ready',snapshot:await snapshot()},'*');
    addEventListener('message',async event=>{if(event.data==='snapshot')parent.postMessage({kind:'inline-after',snapshot:await snapshot()},'*');});
  })();`;
  const markup='<link rel="stylesheet" href="style.css"><script src="external.js"></script><script>'+code+'</script>';
  await native.route(origin+'/**',route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    return route.fulfill(path.endsWith('/echo')?{contentType:'application/json',body:JSON.stringify({url:request.url(),origin:request.headers().origin??null,referrer:request.headers().referer??null,cookie:request.headers().cookie??null})}:
      path.endsWith('.js')?{contentType:'text/javascript',body:path.endsWith('/worker.js')?workerCode:external}:path.endsWith('.css')?{contentType:'text/css',body:'body { color: rgb(1, 2, 3); }'}:{contentType:'text/html',body:parent});
  });
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const read=(proxy,source)=>evaluate(proxy,'JSON.stringify('+source+')').then(JSON.parse);
  const until=async predicate=>{
    const deadline=Date.now()+10000;
    while(!await predicate()){if(Date.now()>deadline)throw new Error('Inline frame fixture timed out');await new Promise(resolve=>setTimeout(resolve,20));}
  };
  const run=async proxy=>{
    const results=[];
    for(const sandbox of [null,'allow-scripts','allow-scripts allow-same-origin']){
      console.log(JSON.stringify({fixture:'Inline frame',proxy,sandbox}));
      if(proxy)await page.evaluate(async({start,parent})=>{main_frame.special_pages[start]=parent;await main_frame.navigate_to(start);},{start,parent});
      else await native.goto(start);
      await evaluate(proxy,`document.cookie='root=one; Path=/';document.cookie='parent=one; Path=/parent';document.cookie='assets=one; Path=/assets';localStorage.shared='parent';
        globalThis.inlineMessages=[];globalThis.inlineLoads=0;addEventListener('message',event=>{if(event.data?.kind?.startsWith('inline-'))inlineMessages.push({data:event.data,origin:event.origin,source:event.source===child.contentWindow});});
        globalThis.child=document.createElement('iframe');child.onload=()=>inlineLoads++;${sandbox===null?'':'child.sandbox='+JSON.stringify(sandbox)+';'}
        child.src='/should-not-fetch';child.srcdoc=${JSON.stringify(markup)};document.body.append(child);true`);
      try{await until(()=>evaluate(proxy,"inlineMessages.some(entry=>entry.data.kind==='inline-ready')&&inlineLoads>=1"));}
      catch(error){throw new Error(error.message+': '+JSON.stringify({proxy,sandbox,state:await read(proxy,'({messages:inlineMessages,loads:inlineLoads,html:child.outerHTML})'),frames:await Promise.all((proxy?page:native).frames().map(async frame=>{try{return await frame.evaluate(()=>({url:location.href,virtual:globalThis.sandstone_frame?.loader.url,loaded:globalThis.sandstone_frame?.loader.is_loaded,ready:document.readyState,phase:globalThis.sandstone_frame?.loader.ready_state,onload:typeof document.querySelector("iframe")?.onload}));}catch(error){return error.message;}}))}));}
      results.push(await read(proxy,`({message:inlineMessages.find(entry=>entry.data.kind==='inline-ready'),src:child.getAttribute('src'),srcdoc:child.srcdoc===${JSON.stringify(markup)},attribute:child.getAttributeNode('srcdoc').value===child.srcdoc,sandbox:child.getAttribute('sandbox'),tokens:child.sandbox.value,loads:inlineLoads})`));
      await evaluate(proxy,"document.querySelector('base').href='/changed/';history.replaceState(null,'','/moved/page');child.contentWindow.postMessage('snapshot','*');true");
      await until(()=>evaluate(proxy,"inlineMessages.some(entry=>entry.data.kind==='inline-after')"));
      results.push(await read(proxy,"inlineMessages.find(entry=>entry.data.kind==='inline-after')"));
      if(sandbox===null)results.push(await read(proxy,"({href:child.contentWindow.location.href,indexed:frames[0]===child.contentWindow})"));
    }
    return results;
  };
  try{
    const expected=await run(false);
    await page.evaluate(({origin,external,parent,workerCode})=>{
      const previous=sandstone.network.session.fetch;globalThis.inlineRequests=[];
      sandstone.network.session.fetch=(url,options)=>{
        if(!url.startsWith(origin+'/'))return previous(url,options);
        inlineRequests.push(url);const path=new URL(url).pathname,headers=new Headers(options.headers);
        return Promise.resolve(path.endsWith('/echo')?Response.json({url,origin:headers.get('origin'),referrer:headers.get('referer'),cookie:headers.get('cookie')}):
          new Response(path.endsWith('/worker.js')?workerCode:path.endsWith('.js')?external:path.endsWith('.css')?'body { color: rgb(1, 2, 3); }':parent,{headers:{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html'}}));
      };
    },{origin,external,parent,workerCode});
    const actual=await run(true);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Inline frame parity: '+JSON.stringify({expected,actual}));
    if(await page.evaluate(()=>inlineRequests.some(url=>url.includes('should-not-fetch')||url.includes('/changed/'))))throw new Error('Inline frame precedence or frozen base failed');
    const mutations=async proxy=>{
      await evaluate(proxy,"child.remove();globalThis.child=document.createElement('iframe');globalThis.inlineLoads=0;globalThis.mutations=[];child.onload=()=>inlineLoads++;addEventListener('message',event=>{if(event.data?.mutation!==undefined)mutations.push(event.data.mutation);});document.body.append(child);true");
      const values=[];
      const actions=[
        "child.srcdoc=source",
        "Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'srcdoc').set.call(child,source)",
        "Element.prototype.setAttribute.call(child,'SRCDOC',source)",
        "child.setAttributeNS(null,'srcdoc',source)",
        "child.getAttributeNode('srcdoc').value=source",
        "(()=>{const attribute=document.createAttribute('srcdoc');attribute.value=source;child.attributes.setNamedItem(attribute);})()"
      ];
      for(let index=0;index<actions.length;index++){
        console.log(JSON.stringify({fixture:'Inline attributes',proxy,index}));
        const source='<script>parent.postMessage({mutation:'+index+'},"*")</script>';
        const before=await evaluate(proxy,'inlineLoads');
        values.push(await read(proxy,`(()=>{const source=${JSON.stringify(source)};${actions[index]};return {property:child.srcdoc,attribute:child.getAttribute('srcdoc'),node:child.attributes.getNamedItem('srcdoc').value,serialized:child.outerHTML.includes('&lt;script&gt;')};})()`));
        await until(()=>evaluate(proxy,`mutations.includes(${index})&&inlineLoads>${before}`));
      }
      const before=await evaluate(proxy,'inlineLoads');
      await evaluate(proxy,"child.srcdoc='';child.src='/ignored-empty';true");
      await until(()=>evaluate(proxy,'inlineLoads>'+before));
      values.push(await read(proxy,"({source:child.srcdoc,present:child.hasAttribute('srcdoc'),src:child.getAttribute('src'),srcNode:child.getAttributeNode('src').value})"));
      await evaluate(proxy,"child.srcdoc='<script>parent.postMessage({mutation:99},\"*\")<\\/script>';globalThis.clone=child.cloneNode(true);child.remove();child=clone;document.body.append(child);true");
      await until(()=>evaluate(proxy,'mutations.includes(99)'));
      values.push(await read(proxy,"({source:child.srcdoc,attribute:child.getAttribute('srcdoc')})"));
      return values;
    };
    const expectedMutations=await mutations(false),actualMutations=await mutations(true);
    if(JSON.stringify(actualMutations)!==JSON.stringify(expectedMutations))throw new Error('Inline attribute parity: '+JSON.stringify({expectedMutations,actualMutations}));
    if(await page.evaluate(()=>inlineRequests.some(url=>url.includes('/ignored-empty'))))throw new Error('Empty srcdoc did not override src');
    const lifecycle=async proxy=>{
      const values=[];
      values.push(await read(proxy,"(()=>{child.sandbox.add();child.sandbox.remove('allow-scripts');return child.hasAttribute('sandbox');})()"));
      await evaluate(proxy,`child.remove();globalThis.child=document.createElement('iframe');globalThis.inlineLoads=0;globalThis.mutations=[];child.onload=()=>inlineLoads++;child.sandbox='';child.srcdoc=${JSON.stringify('<body onload="parent.postMessage({mutation:601},\'*\')"><script>parent.postMessage({mutation:602},"*")</script>')};document.body.append(child);true`);
      await until(()=>evaluate(proxy,'inlineLoads===1'));
      values.push(await read(proxy,"({messages:mutations,source:child.getAttribute('srcdoc'),sandbox:child.sandbox.value})"));
      await evaluate(proxy,"child.sandbox.add('allow-scripts');child.sandbox.value+=' allow-same-origin';child.srcdoc='<script>parent.postMessage({mutation:603},\"*\")<\\/script>';true");
      await until(()=>evaluate(proxy,'mutations.includes(603)&&inlineLoads===2'));
      values.push(await read(proxy,"({sandbox:child.sandbox.value,attribute:child.getAttributeNode('sandbox').value})"));
      await evaluate(proxy,"child.contentWindow.location.hash='part';true");
      await until(()=>evaluate(proxy,"child.contentWindow.location.href==='about:srcdoc#part'"));
      values.push(await read(proxy,"({url:child.contentWindow.location.href,source:child.srcdoc})"));
      await evaluate(proxy,'child.contentWindow.location.reload();true');
      await until(()=>evaluate(proxy,'mutations.filter(value=>value===603).length===2&&inlineLoads===3'));
      values.push(await read(proxy,'({url:child.contentWindow.location.href,loads:inlineLoads})'));
      await evaluate(proxy,"child.src='/fallback';globalThis.removedSource=child.getAttributeNode('srcdoc');child.removeAttributeNode(removedSource);true");
      await until(()=>evaluate(proxy,'inlineLoads===4'));
      values.push(await read(proxy,"({source:child.srcdoc,present:child.hasAttribute('srcdoc'),detached:removedSource.ownerElement===null,value:removedSource.value})"));
      return values;
    };
    const expectedLifecycle=await lifecycle(false),actualLifecycle=await lifecycle(true);
    if(JSON.stringify(actualLifecycle)!==JSON.stringify(expectedLifecycle))throw new Error('Inline lifecycle parity: '+JSON.stringify({expectedLifecycle,actualLifecycle}));
    const parsedSource='<!doctype html><base href="/assets/"><script>globalThis.parserMessages=[];addEventListener("message",event=>{if(event.data?.parserBase)parserMessages.push(event.data.parserBase);});</script><iframe srcdoc="&lt;script&gt;parent.postMessage({parserBase:document.baseURI},\' *\'.trim())&lt;/script&gt;"></iframe><script>document.querySelector("base").href="/changed/";window.onload=()=>globalThis.parserLoaded=true;</script>';
    await native.setContent(parsedSource);
    await until(()=>native.evaluate(()=>globalThis.parserLoaded&&parserMessages.length===1));
    const expectedParser=await native.evaluate(()=>parserMessages);
    await page.evaluate(async({origin,parsedSource})=>{main_frame.special_pages[origin+'/parser']=parsedSource;await main_frame.navigate_to(origin+'/parser');},{origin,parsedSource});
    const actualParser=await read(true,'({loaded:globalThis.parserLoaded,messages:parserMessages})');
    if(!actualParser.loaded||JSON.stringify(actualParser.messages)!==JSON.stringify(expectedParser))throw new Error('Parser-created inline frame base/load parity: '+JSON.stringify({expectedParser,actualParser}));
    await page.evaluate(()=>{
      const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=async(url,options)=>{
        if(url==='https://srcdoc.test/hold.js'){await new Promise(resolve=>globalThis.releaseInlineScript=resolve);return new Response('parent.postMessage({mutation:700},"*")',{headers:{'Content-Type':'text/javascript'}});}
        return previous(url,options);
      };
    });
    await evaluate(true,"document.querySelector('iframe').remove();globalThis.mutations=[];globalThis.inlineLoads=0;addEventListener('message',event=>{if(event.data?.mutation!==undefined)mutations.push(event.data.mutation);});globalThis.child=document.createElement('iframe');child.onload=()=>inlineLoads++;child.srcdoc='<script src=\"/hold.js\"><\\/script>';document.body.append(child);true");
    await until(()=>page.evaluate(()=>typeof releaseInlineScript==='function'));
    await evaluate(true,"child.srcdoc='<script>parent.postMessage({mutation:701},\"*\")<\\/script>';true");
    await until(()=>evaluate(true,'mutations.includes(701)&&inlineLoads===1'));
    await page.evaluate(()=>releaseInlineScript());
    await page.waitForTimeout(40);
    if(await evaluate(true,'mutations.includes(700)||inlineLoads!==1'))throw new Error('Superseded inline document completed or executed stale scripts');
    return ['Inline frame scripts, styles, workers and fetches use the relay','Inline frames inherit origin, cookie URL and storage while preserving about:srcdoc','Inline frame bases remain frozen while request referrers follow parent history','Inline frame sandbox tokens, opaque origins and message sources match native behavior','Inline frame property, Attr, namespace and NamedNodeMap writes preserve authored markup','Empty and cloned inline documents retain srcdoc precedence','Inline frames honor script sandboxing and DOMTokenList updates','Inline frame fragments, reloads and src fallback preserve authored attributes','Parser-created inline frames preserve creation bases and delay parent load','Replacing inline frames cancels blocked initialization and stale scripts'];
  }finally{await context.close();}
}
