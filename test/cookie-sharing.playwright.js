async page=>{
  const origin='https://cookie-sharing.test',url=origin+'/a/page',html='<!doctype html><body>Shared cookies';
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route(origin+'/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path==='/echo')return route.fulfill({contentType:'application/json',body:JSON.stringify({cookie:request.headers().cookie||''})});
    return route.fulfill({contentType:'text/html',body:html,headers:path==='/set'?{'Set-Cookie':'server=updated; Path=/; Secure; SameSite=Lax'}:{}});
  });
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const run=async proxy=>{
    if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),url);else await native.goto(url);
    let peer;
    if(proxy)await page.evaluate(async url=>{globalThis.cookieSharingPeer=new sandstone.controller.ProxyFrame();document.body.append(cookieSharingPeer.iframe);await cookieSharingPeer.navigate_to(url);},origin+'/c/page');
    else{peer=await context.newPage();await peer.goto(origin+'/c/page');}
    const peerEvaluate=source=>proxy?page.evaluate(source=>cookieSharingPeer.eval_js(source),source):peer.evaluate(source=>eval(source),source);
    const wait=async predicate=>{const deadline=Date.now()+5000;while(!await predicate()){if(Date.now()>deadline)throw new Error('Cookie publication did not finish');await new Promise(resolve=>setTimeout(resolve,20));}};
    try{
    const result=JSON.parse(await evaluate(proxy,`(async()=>{
      const snapshot=doc=>doc.cookie.split('; ').filter(Boolean).sort();
      const ephemeral=document.createElement('iframe');document.body.append(ephemeral);
      ephemeral.contentDocument.cookie='ephemeral=accepted; Path=/; Secure';ephemeral.remove();
      const blank=document.createElement('iframe');document.body.append(blank);
      const loaded=document.createElement('iframe');loaded.src=${JSON.stringify(origin+'/b/page')};const ready=new Promise(resolve=>loaded.onload=resolve);document.body.append(loaded);await ready;
      const docs=[document,blank.contentDocument,loaded.contentDocument],reads=[],published=()=>new Promise(resolve=>setTimeout(resolve,10));
      document.cookie='shared=parent; Path=/; Secure';await published();reads.push(docs.map(snapshot));
      blank.contentDocument.cookie='shared=blank; Path=/; Secure';await published();reads.push(docs.map(snapshot));
      loaded.contentDocument.cookie='shared=loaded; Path=/; Secure';await published();reads.push(docs.map(snapshot));
      loaded.contentDocument.cookie='scoped=child; Path=/b/; Secure';await published();reads.push(docs.map(snapshot));
      document.cookie='counter=0; Path=/; Secure';
      for(let index=0;index<12;index++){const doc=docs[index%3];const previous=Number(/(?:^|; )counter=(\\d+)/.exec(doc.cookie)?.[1]);doc.cookie='counter='+(previous+1)+'; Path=/; Secure';}
      reads.push(docs.map(snapshot));
      blank.contentDocument.cookie='shared=; Max-Age=0; Path=/; Secure';await published();reads.push(docs.map(snapshot));
      const echo=await loaded.contentWindow.fetch('/echo',{cache:'no-store'}).then(response=>response.json());
      await fetch('/set',{cache:'no-store'});reads.push(docs.map(snapshot));
      const invalid=[];try{document.cookie=Symbol('cookie');invalid.push('accepted');}catch(error){invalid.push(error.name);}
      blank.remove();loaded.remove();return JSON.stringify({reads,echo:echo.cookie.split('; ').filter(Boolean).sort(),invalid});
    })()`));
    if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),url);else await native.goto(url);
    result.reloaded=JSON.parse(await evaluate(proxy,`JSON.stringify(document.cookie.split('; ').filter(Boolean).sort())`));
    await wait(async()=>await peerEvaluate('document.cookie.includes("server=updated")&&document.cookie.includes("counter=12")'));
    await peerEvaluate('document.cookie="peer=published; Path=/; Secure";true');
    await wait(()=>evaluate(proxy,'document.cookie.includes("peer=published")'));
    result.peer={parent:JSON.parse(await evaluate(proxy,'JSON.stringify(document.cookie.split("; ").filter(Boolean).sort())')),other:JSON.parse(await peerEvaluate('JSON.stringify(document.cookie.split("; ").filter(Boolean).sort())'))};
    if(proxy)await page.evaluate(()=>sandstone.controller.site_data.clear('cookie-sharing.test',{localStorage:false}));else await context.clearCookies();
    await wait(async()=>await evaluate(proxy,'document.cookie===""')&&await peerEvaluate('document.cookie===""'));
    result.cleared={parent:await evaluate(proxy,'document.cookie'),other:await peerEvaluate('document.cookie')};
    return result;
    }finally{
      if(proxy)await page.evaluate(()=>{sandstone.network.clean_ws_connections(cookieSharingPeer.id);cookieSharingPeer.iframe.remove();cookieSharingPeer.rpc_target.target.close();delete sandstone.controller.iframes[cookieSharingPeer.id];delete globalThis.cookieSharingPeer;});
      else await peer.close();
    }
  };
  try{
    const expected=await run(false);
    await page.evaluate(({origin,html})=>{
      const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=(url,options)=>{
        if(new URL(url).origin!==origin)return previous(url,options);
        const path=new URL(url).pathname;
        if(path==='/echo')return Promise.resolve(new Response(JSON.stringify({cookie:new Headers(options.headers).get('cookie')||''}),{headers:{'Content-Type':'application/json'}}));
        const response=new Response(html,{headers:{'Content-Type':'text/html'}});
        if(path==='/set')Object.defineProperty(response,'raw_headers',{value:[['Content-Type','text/html'],['Set-Cookie','server=updated; Path=/; Secure; SameSite=Lax']]});
        return Promise.resolve(response);
      };
    },{origin,html});
    const actual=await run(true);
    if(JSON.stringify(actual)!==JSON.stringify(expected)){console.log(JSON.stringify({cookieSharing:{expected,actual}}));throw new Error('Shared cookie behavior differs from native');}
    return ['Same-origin frame cookie writes and deletions are immediately visible with document path filtering','Alternating frame cookie writes preserve their order in requests and across navigation','Server cookie changes update accessible frame documents without exposing stale snapshots','Cookie changes and per-site clearing update separate open pages without additional requests'];
  }finally{await context.close();}
}
