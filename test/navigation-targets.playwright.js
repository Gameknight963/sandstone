async page=>{
  const a='https://targets.test',b='https://targets-other.test';
  const native=await page.context().newPage(),requests=[];
  const html=url=>{
    const path=new URL(url).pathname;
    if(path==='/target/start')return `<!doctype html><base href="/target/base/" target="results"><body>
      <iframe id="destination" name="results"></iframe><a id="link" href="${b}/target/landing">Go</a>
      <form id="form" action="${b}/target/form" method="post" target="results"><input name="target" value="masked"><input name="q" value="snow 雪"><button id="send" name="go" value="yes">Send</button></form><script>window.ready=true;window.rootMarker=true;<\/script>`;
    if(path==='/target/middle')return `<!doctype html><body><iframe src="${b}/target/source"></iframe><script>window.ready=true;<\/script>`;
    if(path==='/target/source')return `<!doctype html><meta name="referrer" content="unsafe-url"><body><a id="up" target="_parent" href="${a}/target/up">Up</a><form id="topForm" target="_top" method="post" action="${a}/target/up-form"><input name="from" value="nested"><button id="topSend">Top</button></form><script>window.ready=true;<\/script>`;
    return '<!doctype html><body><h1>Destination</h1><div id="anchor"></div><script>window.ready=true;<\/script>';
  };
  await page.context().addCookies([{url:a,name:'targetStrict',value:'1',sameSite:'Strict'},{url:a,name:'targetLax',value:'1',sameSite:'Lax'}]);
  for(const origin of [a,b])await native.route(origin+'/**',async route=>{
    const request=route.request(),headers=await request.allHeaders();
    if(new URL(request.url()).pathname.startsWith('/target/'))requests.push({url:request.url(),method:request.method(),body:request.postData()||'',origin:headers.origin||'',referer:headers.referer||'',cookie:headers.cookie||''});
    await route.fulfill({contentType:'text/html',body:html(request.url())});
  });
  await page.evaluate(({a,b,html})=>{
    const body=(0,eval)('('+html+')'),previous=sandstone.network.session.fetch;
    globalThis.targetRequests=[];
    sandstone.network.session.fetch=(url,options)=>{
      if(![a,b].includes(new URL(url).origin))return previous(url,options);
      const headers=new Headers(options.headers);
      if(new URL(url).pathname.startsWith('/target/'))targetRequests.push({url,method:options.method||'GET',body:options.body?new TextDecoder().decode(options.body):'',origin:headers.get('origin')||'',referer:headers.get('referer')||'',cookie:headers.get('cookie')||''});
      return Promise.resolve(new Response(body(url),{headers:{'Content-Type':'text/html'}}));
    };
    sandstone.controller.site_data.setCookie(a+'/','targetStrict=1; SameSite=Strict; Path=/',true);
    sandstone.controller.site_data.setCookie(a+'/','targetLax=1; SameSite=Lax; Path=/',true);
  },{a,b,html:html.toString().replaceAll('${b}',b).replaceAll('${a}',a)});
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const find=async(proxy,prefix)=>{
    const expires=Date.now()+10000;
    while(Date.now()<expires){
      for(const frame of (proxy?page:native).frames())try{
        if(frame.isDetached())continue;
        const info=await frame.evaluate(proxy=>proxy?{url:globalThis.sandstone_frame?.loader.url,id:globalThis.sandstone_frame?.loader.frame_id,token:globalThis.sandstone_frame?.loader.beacon_context,ready:globalThis.sandstone_frame?.context.run_script('window.ready===true')}:{url:location.href,ready:window.ready===true},proxy);
        if(info.ready&&info.url?.startsWith(prefix)&&(!proxy||await page.evaluate(({id,token})=>!!sandstone.controller.iframes[id]&&!!sandstone.network.beacons.contexts.get(token)&&!sandstone.network.beacons.contexts.get(token).retired,info)))return frame;
      }catch{}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const frames=[];for(const frame of (proxy?page:native).frames())try{frames.push(await frame.evaluate(()=>({url:globalThis.sandstone_frame?.loader.url||location.href,ready:globalThis.sandstone_frame?.loader.ready_state})));}catch{}
    throw new Error('Target navigation did not arrive: '+JSON.stringify({proxy,prefix,requests:proxy?await page.evaluate(()=>targetRequests):requests,frames}));
  };
  const frameRead=(proxy,frame,source)=>frame.evaluate(({proxy,source})=>proxy?sandstone_frame.context.run_script(source):eval(source),{proxy,source});
  const start=async proxy=>{
    if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),a+'/target/start');else await native.goto(a+'/target/start');
    if(proxy)await page.evaluate(()=>{targetRequests=[];});else requests.length=0;
  };
  const last=proxy=>proxy?page.evaluate(()=>targetRequests.at(-1)):requests.at(-1);
  const summary=async(proxy,frame)=>({request:await last(proxy),document:JSON.parse(await frameRead(proxy,frame,'JSON.stringify({url:location.href,referrer:document.referrer})')),root:JSON.parse(await evaluate(proxy,'JSON.stringify({url:location.href,kept:window.rootMarker===true})'))});
  const run=async proxy=>{
    await (proxy?page:native).bringToFront();
    const values=[];
    const cases=[
      "document.querySelector('base').target='unused';document.getElementById('link').target='results';document.getElementById('link').click();",
      "document.getElementById('link').rel='noreferrer';document.getElementById('link').click();",
      "const form=document.getElementById('form');form.method='get';HTMLFormElement.prototype.submit.call(form);",
      "const form=document.getElementById('form');form.setAttribute('target','unused');document.getElementById('send').formTarget='results';form.requestSubmit(document.getElementById('send'));",
      "const form=document.getElementById('form');form.removeAttribute('target');HTMLFormElement.prototype.submit.call(form);",
      "document.getElementById('send').setAttribute('formtarget','');document.getElementById('form').requestSubmit(document.getElementById('send'));",
      "document.getElementById('form').setAttribute('target','_self');document.getElementById('send').setAttribute('formtarget','');document.getElementById('form').requestSubmit(document.getElementById('send'));",
      "document.getElementById('form').setAttribute('target','');document.getElementById('form').requestSubmit(document.getElementById('send'));",
      "document.getElementById('link').target='';document.getElementById('link').click();"
    ];
    for(let index=0;index<cases.length;index++){
      await start(proxy);await evaluate(proxy,'setTimeout(()=>{'+cases[index]+'},0);true');
      const frame=await find(proxy,b+(cases[index].includes("'link'")?'/target/landing':'/target/form'));
      values.push(await summary(proxy,frame));
      if(index===0){
        const count=proxy?await page.evaluate(()=>targetRequests.length):requests.length;
        await evaluate(proxy,`document.getElementById('link').href=${JSON.stringify(b+'/target/landing#anchor')};document.getElementById('link').click();true`);
        await find(proxy,b+'/target/landing#anchor');
        values.push({fragment:await summary(proxy,frame),noRequest:(proxy?await page.evaluate(()=>targetRequests.length):requests.length)===count});
      }
    }
    for(const top of [false,true]){
      await start(proxy);await evaluate(proxy,`document.getElementById('destination').src=${JSON.stringify((top?a:b)+'/target/middle')};true`);
      const source=await find(proxy,b+'/target/source');
      await source.locator(top?'#topSend':'#up').click();
      const destination=await find(proxy,a+(top?'/target/up-form':'/target/up'));
      values.push(await summary(proxy,destination));
    }
    for(const [sandbox,target,blocked,post=false,scripted=false] of [[null,'_parent',true],['allow-scripts allow-forms','_top',true],['ALLOW-SCRIPTS allow-forms ALLOW-TOP-NAVIGATION-BY-USER-ACTIVATION','_top',false],['allow-scripts allow-forms allow-top-navigation-by-user-activation','_top',false,true],['allow-scripts allow-forms allow-top-navigation','_top',false,false,true]]){
      await start(proxy);
      await evaluate(proxy,`const frame=document.getElementById('destination');${sandbox===null?'':`frame.sandbox=${JSON.stringify(sandbox)};`}frame.src=${JSON.stringify(a+'/target/middle')};true`);
      const source=await find(proxy,b+'/target/source');
      await frameRead(proxy,source,`document.getElementById('up').target=${JSON.stringify(target)};document.getElementById('up').href=${JSON.stringify(a+'/target/sandbox-up')};true`);
      if(post)await frameRead(proxy,source,`document.getElementById('topForm').action=${JSON.stringify(a+'/target/sandbox-up')};true`);
      const count=proxy?await page.evaluate(()=>targetRequests.length):requests.length;
      if(scripted)await frameRead(proxy,source,'setTimeout(()=>document.getElementById("up").click(),0);true');
      else await source.locator(post?'#topSend':'#up').click();
      if(blocked){
        await frameRead(proxy,source,'new Promise(resolve=>setTimeout(resolve,50))');
        values.push({blocked:(proxy?await page.evaluate(()=>targetRequests.length):requests.length)===count,source:await frameRead(proxy,source,'location.href')});
      }else values.push(await summary(proxy,await find(proxy,a+'/target/sandbox-up')));
    }
    return values;
  };
  try{
    const expected=await run(false),actual=await run(true);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Navigation target parity: '+JSON.stringify({expected,actual}));
    await start(true);
    await evaluate(true,`window.name='RootTarget';document.getElementById('destination').src=${JSON.stringify(b+'/target/source')};true`);
    const source=await find(true,b+'/target/source');
    await frameRead(true,source,`document.getElementById('up').target='RootTarget';document.getElementById('up').href=${JSON.stringify(b+'/target/landing')};true`);
    await page.evaluate(()=>{
      const target=main_frame.rpc_target,port=target.target,post=port.postMessage,receive=target.onmessage;
      const gate=globalThis.targetLookupGate={restore(){port.postMessage=post;target.onmessage=receive;delete globalThis.targetLookupGate;}};
      port.postMessage=function(message,...args){
        if(message.procedure==='find_navigation_target'&&message.arguments[0]==='RootTarget')gate.id=message.id;
        return Reflect.apply(post,this,[message,...args]);
      };
      target.onmessage=(event,target)=>{
        if(event.data.type==='reply'&&event.data.id===gate.id){gate.waiting=true;gate.release=()=>receive(event,target);}
        else return receive(event,target);
      };
    });
    try{
      await source.locator('#up').click();
      await page.waitForFunction(()=>targetLookupGate.waiting);
      await page.evaluate(url=>main_frame.navigate_to(url),a+'/target/replacement');
      await page.evaluate(()=>targetLookupGate.release());
      await page.waitForTimeout(50);
      if(await evaluate(true,'location.href')!==a+'/target/replacement'||await page.evaluate(()=>targetRequests.some(request=>request.url.endsWith('/target/landing'))))throw new Error('A retired document completed an old target lookup');
      const root=page.frames().find(frame=>frame.parentFrame()===page.mainFrame());
      const count=await page.evaluate(()=>targetRequests.length);
      const invalid=await root.evaluate(async url=>{try{await sandstone_frame.rpc.call_procedure(sandstone_frame.rpc.host,'navigate_target',[sandstone_frame.loader.frame_id,'invalid-document','_top',url,null,{}]);return 'accepted';}catch(error){return error.name;}},b+'/target/landing');
      if(invalid!=='SecurityError')throw new Error('An invalid document token was not rejected');
      if(await page.evaluate(()=>targetRequests.length)!==count)throw new Error('An invalid document token authorized target navigation');
    }finally{await page.evaluate(()=>targetLookupGate?.restore());}
    return ['Named link/form targets navigate blank and existing frames through the relay','Base targets, submitter overrides and masked form target controls match native navigation','Targeted fragments retain their document without another request','Nested parent/top navigations preserve initiating Origin, Referer, cookies and document.referrer','Origin and inherited sandbox restrictions block forbidden ancestor navigation and honor activated top navigation','Retired target lookups and invalid document tokens cannot navigate a newer document'];
  }finally{await native.close();}
}
