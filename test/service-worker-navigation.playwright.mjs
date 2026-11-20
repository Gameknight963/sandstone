import assert from 'node:assert/strict';

export async function verifyServiceWorkerNavigation(page){
  const fixture=await page.context().newPage(),origin='https://navigation-worker.test',errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
  try{
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.evaluate(async origin=>{
      await sandstone.service_workers.clear_registrations(new URL(origin).hostname);
      const html=kind=>'<!doctype html><body>'+kind+'<script>globalThis.navResult='+JSON.stringify({kind})+';navResult.url=location.href;navResult.base=document.baseURI;</script>';
      const source=`oninstall=event=>event.waitUntil(caches.open('navigation').then(cache=>cache.add('/network-shell')));
        onfetch=event=>{
          const path=new URL(event.request.url).pathname;
          if(path==='/who'){event.respondWith(new Response(event.clientId));return;}
          if(event.request.mode!=='navigate')return;
          if(path==='/app/pass-about'){event.respondWith(fetch(new Request(event.request,{referrer:'about:client',referrerPolicy:'unsafe-url'})));return;}
          if(path==='/app/no-content'){event.respondWith(new Response(null,{status:204}));return;}
          if(path==='/app/network-redirect'||path==='/app/pass'){if(path.endsWith('/pass'))event.respondWith(fetch(event.request));return;}
          if(path==='/app/cached'){event.respondWith(caches.match('/network-shell'));return;}
          if(path==='/app/redirect'){event.respondWith(Response.redirect(new URL('/other/page',event.request.url).href,302));return;}
          if(path==='/app/hold'){
            event.respondWith(new Promise(resolve=>{event.request.signal.addEventListener('abort',()=>{fetch('/aborted');resolve(new Response('late'));},{once:true});fetch('/held');}));return;
          }
          if(path==='/app/stream'){
            event.request.signal.addEventListener('abort',()=>fetch('/stream-aborted'),{once:true});
            event.respondWith(new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('<body>pending'));fetch('/streaming');}}),{headers:{'content-type':'text/html'}}));return;
          }
          const data={kind:'worker',mode:event.request.mode,cloneMode:event.request.clone().mode,copyMode:new Request(event.request).mode,copyDestination:new Request(event.request).destination,cloneDestination:event.request.clone().destination,redirect:event.request.redirect,destination:event.request.destination,client:event.clientId,resulting:event.resultingClientId};
          event.respondWith(new Response('<!doctype html><body>worker<script>globalThis.navResult='+JSON.stringify(data)+';navResult.url=location.href;navResult.base=document.baseURI;</'+'script>',{headers:{'content-type':'text/html'}}));
        };`;
      globalThis.navRequests=[];globalThis.navTransport=[];globalThis.navFlags={};globalThis.navOffline=false;
      sandstone.network.session.fetch=async(url,options)=>{
        const path=new URL(url).pathname;navRequests.push(path);
        if(path.startsWith('/app/pass'))navTransport.push({method:options.method,headers:options.headers,body:options.body==null?'':new TextDecoder().decode(options.body)});
        if(['/held','/aborted','/streaming','/stream-aborted'].includes(path)){navFlags[path]=true;return new Response('ready');}
        if(path==='/worker.js')return new Response(source,{headers:{'content-type':'text/javascript','cache-control':'no-store'}});
        if(navOffline)throw new TypeError('Offline');
        if(path==='/app/network-redirect')return new Response(null,{status:302,headers:{location:'/other/page'}});
        return new Response(html(path==='/network-shell'?'cached':'network'),{headers:{'content-type':'text/html','cache-control':'no-store'}});
      };
      main_frame.on_load=()=>{};await main_frame.navigate_to(origin+'/outside');
      const manager=sandstone.service_workers.manager;
      globalThis.navOne=await manager.register(origin+'/worker.js',{scope:origin+'/app/'},{base:origin+'/outside',origin});await manager.settled(navOne);
      globalThis.navTwo=await manager.register(origin+'/worker.js',{scope:origin+'/other/'},{base:origin+'/outside',origin});await manager.settled(navTwo);
    },origin);
    const generated=await fixture.evaluate(async origin=>{
      const previous=main_frame.document_context;await main_frame.navigate_to(origin+'/app/page');
      const data=JSON.parse(await main_frame.eval_js('JSON.stringify(navResult)'));
      return {data,previous,token:main_frame.document_context,controlled:sandstone.service_workers.manager.clients.get(main_frame.document_context)?.controller===navOne.active};
    },origin);
    assert.deepEqual(generated,{data:{kind:'worker',mode:'navigate',cloneMode:'navigate',copyMode:'navigate',copyDestination:'',cloneDestination:'document',redirect:'manual',destination:'document',client:generated.previous,resulting:generated.token,url:origin+'/app/page',base:origin+'/app/page'},previous:generated.previous,token:generated.token,controlled:true});
    const cached=await fixture.evaluate(async origin=>{
      navOffline=true;await main_frame.navigate_to(origin+'/app/cached');navOffline=false;
      return {url:main_frame.url.href,data:JSON.parse(await main_frame.eval_js('JSON.stringify(navResult)'))};
    },origin);
    assert.deepEqual(cached,{url:origin+'/app/cached',data:{kind:'cached',url:origin+'/app/cached',base:origin+'/app/cached'}});
    const empty=await fixture.evaluate(async origin=>{
      const token=main_frame.document_context,length=main_frame.history.entries.length;const result=await main_frame.navigate_to(origin+'/app/no-content');
      return {result,url:main_frame.url.href,same:main_frame.document_context===token,history:main_frame.history.entries.length===length,pending:sandstone.service_workers.navigations.pending.size};
    },origin);
    assert.deepEqual(empty,{result:{no_navigation:true},url:origin+'/app/cached',same:true,history:true,pending:0});
    for(const path of ['/app/redirect','/app/network-redirect']){
      const result=await fixture.evaluate(async({origin,path})=>{
        await main_frame.navigate_to(origin+path);return {url:main_frame.url.href,kind:JSON.parse(await main_frame.eval_js('JSON.stringify(navResult)')).kind,controlled:sandstone.service_workers.manager.clients.get(main_frame.document_context)?.controller===navTwo.active};
      },{origin,path});
      assert.deepEqual(result,{url:origin+'/other/page',kind:'worker',controlled:true});
    }
    const pass=await fixture.evaluate(async origin=>{await main_frame.navigate_to(origin+'/app/pass');return JSON.parse(await main_frame.eval_js('JSON.stringify(navResult)'));},origin);
    assert.deepEqual(pass,{kind:'network',url:origin+'/app/pass',base:origin+'/app/pass'});
    await fixture.evaluate(async origin=>{
      await main_frame.navigate_to('https://initiator.test/source');
      sandstone.controller.site_data.setCookie(origin+'/','recent=allowed; Path=/');
      sandstone.controller.site_data.setCookie(origin+'/','strict=private; SameSite=Strict; Path=/');
      await main_frame.eval_js(`(()=>{const form=document.createElement('form');form.action=${JSON.stringify(origin+'/app/pass')};form.method='POST';form.innerHTML='<input name="field" value="posted">';document.body.append(form);form.submit();})()`);
    },origin);
    await fixture.waitForFunction(origin=>main_frame.url.href===origin+'/app/pass'&&!main_frame.is_navigating,origin);
    const posted=await fixture.evaluate(()=>navTransport.at(-1));
    assert.equal(posted.method,'POST');assert.equal(posted.body,'field=posted');assert.equal(posted.headers.origin,'https://initiator.test');assert.equal(posted.headers.referer,'https://initiator.test/');
    assert.equal(posted.headers['sec-fetch-mode'],'navigate');assert.equal(posted.headers['sec-fetch-dest'],'empty');assert.equal(posted.headers['sec-fetch-site'],'cross-site');assert.equal(posted.headers.cookie,'recent=allowed');
    await fixture.evaluate(async origin=>{
      await main_frame.navigate_to('https://initiator.test/private/source?hidden=value');
      await main_frame.eval_js(`(()=>{const form=document.createElement('form');form.action=${JSON.stringify(origin+'/app/pass-about')};form.method='POST';document.body.append(form);form.submit();})()`);
    },origin);
    await fixture.waitForFunction(origin=>main_frame.url.href===origin+'/app/pass-about'&&!main_frame.is_navigating,origin);
    const about=await fixture.evaluate(()=>navTransport.at(-1));assert.equal(about.headers.origin,'https://initiator.test');assert.equal(about.headers.referer,origin+'/worker.js');
    await fixture.evaluate(()=>main_frame.eval_js(`(async()=>{const frame=document.createElement('iframe');const loaded=new Promise(resolve=>frame.onload=resolve);frame.src='/app/page';document.body.append(frame);await loaded;})()`));
    const child=await fixture.evaluate(async()=>{
      const frame=Object.values(sandstone.controller.iframes).find(frame=>frame.parent_id===main_frame.id&&!frame.worker);
      const data=JSON.parse(await main_frame.eval_js('JSON.stringify(document.querySelector("iframe").contentWindow.navResult)'));
      return {data,token:frame.document_context,controlled:sandstone.service_workers.manager.clients.get(frame.document_context)?.controller===navOne.active};
    });
    assert.equal(child.data.destination,'iframe');assert.equal(child.data.resulting,child.token);assert.equal(child.controlled,true);assert.equal(child.data.kind,'worker');
    await fixture.evaluate(()=>main_frame.eval_js('document.querySelector("iframe").remove()'));
    for(const [path,flag,aborted] of [['/app/hold','/held','/aborted'],['/app/stream','/streaming','/stream-aborted']]){
      await fixture.evaluate(({origin,path})=>{globalThis.navPending=main_frame.navigate_to(origin+path);}, {origin,path});
      await fixture.waitForFunction(flag=>!!navFlags[flag],flag);
      const replaced=await fixture.evaluate(async origin=>{await main_frame.navigate_to(origin+'/other/page');await navPending;return {url:main_frame.url.href,pending:sandstone.service_workers.navigations.pending.size,reserved:[...sandstone.service_workers.manager.clients.values()].filter(client=>client.reserved).length};},origin);
      assert.deepEqual(replaced,{url:origin+'/other/page',pending:0,reserved:0});await fixture.waitForFunction(flag=>!!navFlags[flag],aborted);
    }
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Navigation workers receive native mode, redirect, destination and stable incoming-document IDs','Cached fallback HTML works offline while preserving the requested URL and base','No-content navigations retain the current document and history','Synthetic and HTTP redirects select the destination worker and document controller','Navigation pass-through and iframe documents stay on the relay','Worker pass-through retains cross-origin form bodies, Origin, Referer, Fetch Metadata and cookie policy','Superseded pending and streaming navigations abort without resurrecting documents or reservations'];
  }finally{await fixture.evaluate(origin=>sandstone.service_workers.clear_registrations(new URL(origin).hostname),origin).catch(()=>{});await fixture.close();}
}
