async page=>{
  const a='https://navigation-life.test',b='https://navigation-life-other.test';
  const native=await page.context().newPage(),gates=new Map();
  const html=url=>{
    const parsed=new URL(url),path=parsed.pathname;
    if(path==='/life/root')return `<!doctype html><body><iframe id="actor" src="${a}/life/actor"></iframe><iframe id="sink" name="sink" ${parsed.searchParams.has('existing')?`src="${b}/life/idle"`:''}></iframe><script>window.ready=true;<\/script>`;
    if(path==='/life/actor')return `<!doctype html><meta name="referrer" content="unsafe-url"><body><form id="send" method="post" target="sink" action="${b}/life/slow"><input name="q" value="retained"></form><script>window.ready=true;<\/script>`;
    return '<!doctype html><body><h1>Loaded</h1><script>window.ready=true;<\/script>';
  };
  for(const origin of [a,b])await native.route(origin+'/**',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.pathname==='/life/slow'){
      const headers=await request.allHeaders();
      await new Promise(resolve=>gates.set(url.searchParams.get('phase'),{release:resolve,request:{method:request.method(),body:request.postData(),origin:headers.origin||'',referer:headers.referer||''}}));
    }
    try{await route.fulfill({contentType:'text/html',body:html(request.url())});}catch{}
  });
  await page.evaluate(({a,b,html})=>{
    const body=(0,eval)('('+html+')'),previous=sandstone.network.session.fetch;
    globalThis.navigationLifetime={gates:{}};
    sandstone.network.session.fetch=(url,options)=>{
      const parsed=new URL(url);
      if(![a,b].includes(parsed.origin))return previous(url,options);
      if(parsed.pathname==='/life/slow')return new Promise((resolve,reject)=>{
        const headers=new Headers(options.headers);
        navigationLifetime.gates[parsed.searchParams.get('phase')]={signal:options.signal,request:{method:options.method,body:new TextDecoder().decode(options.body),origin:headers.get('origin')||'',referer:headers.get('referer')||''},release:()=>resolve(new Response(body(url),{headers:{'Content-Type':'text/html'}}))};
        options.signal.addEventListener('abort',()=>reject(new DOMException('Navigation aborted','AbortError')),{once:true});
      });
      return Promise.resolve(new Response(body(url),{headers:{'Content-Type':'text/html'}}));
    };
  },{a,b,html:html.toString().replaceAll('${a}',a).replaceAll('${b}',b)});
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const until=async(test,label)=>{
    const expires=Date.now()+10000;
    while(!await test()){
      if(Date.now()>expires)throw new Error('Navigation lifetime timed out: '+label);
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  };
  const find=async(proxy,prefix)=>{
    let found;
    await until(async()=>{
      for(const frame of (proxy?page:native).frames())try{
        if(frame.isDetached()||!proxy&&!frame.url().startsWith(prefix))continue;
        let timer;
        const ready=await Promise.race([frame.evaluate(({proxy,prefix})=>proxy?globalThis.sandstone_frame?.loader.url?.startsWith(prefix)&&sandstone_frame.context.run_script('window.ready===true'):location.href.startsWith(prefix)&&window.ready===true,{proxy,prefix}),new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('Frame probe did not respond')),500))]).finally(()=>clearTimeout(timer));
        if(ready){found=frame;return true;}
      }catch{}
      return false;
    },prefix);
    return found;
  };
  const run=async(proxy,phase,existing)=>{
    const root=a+'/life/root?'+(existing?'existing=1':'blank=1');
    if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),root);else await native.goto(root);
    const actor=await find(proxy,a+'/life/actor');
    const sourceToken=proxy?await actor.evaluate(()=>sandstone_frame.loader.beacon_context):null;
    if(existing)await find(proxy,b+'/life/idle');
    await actor.evaluate(({proxy,url,phase})=>{
      const code=`history.replaceState(null,'',${JSON.stringify('/life/actor?revision='+phase+'#private')});document.getElementById('send').action=${JSON.stringify(url)};HTMLFormElement.prototype.submit.call(document.getElementById('send'));true`;
      return proxy?sandstone_frame.context.run_script(code):eval(code);
    },{proxy,url:b+'/life/slow?phase='+phase,phase});
    await until(()=>proxy?page.evaluate(phase=>!!navigationLifetime.gates[phase],phase):gates.has(phase),'accepted '+phase);
    if(phase==='remove')await evaluate(proxy,"document.getElementById('actor').remove();true");
    else{await evaluate(proxy,`document.getElementById('actor').src=${JSON.stringify(a+'/life/replacement')};true`);await find(proxy,a+'/life/replacement');}
    if(proxy){
      await until(()=>page.evaluate(()=>!Object.values(sandstone.controller.iframes).some(frame=>frame.url.pathname==='/life/actor')),'source retirement');
      if(await page.evaluate(phase=>navigationLifetime.gates[phase].signal.aborted,phase))throw new Error('Retiring the initiator aborted the destination navigation');
      await page.evaluate(token=>sandstone.network.beacons.contexts.delete(token),sourceToken);
      await page.evaluate(phase=>navigationLifetime.gates[phase].release(),phase);
    }else gates.get(phase).release();
    const sink=await find(proxy,b+'/life/slow?phase='+phase);
    const document=JSON.parse(await sink.evaluate(proxy=>proxy?sandstone_frame.context.run_script('JSON.stringify({url:location.href,referrer:document.referrer})'):JSON.stringify({url:location.href,referrer:document.referrer}),proxy));
    return {document,request:proxy?await page.evaluate(phase=>navigationLifetime.gates[phase].request,phase):gates.get(phase).request};
  };
  try{
    for(const [phase,existing] of [['remove',false],['replace',true]]){
      const expected=await run(false,phase,existing),actual=await run(true,phase,existing);
      if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Navigation lifetime parity: '+JSON.stringify({expected,actual}));
    }
    await page.evaluate(url=>main_frame.navigate_to(url),a+'/life/root?existing=1&cancel=1');
    const actor=await find(true,a+'/life/actor');await find(true,b+'/life/idle');
    await actor.evaluate(url=>sandstone_frame.context.run_script(`document.getElementById('send').action=${JSON.stringify(url)};HTMLFormElement.prototype.submit.call(document.getElementById('send'));true`),b+'/life/slow?phase=cancel');
    await until(()=>page.evaluate(()=>!!navigationLifetime.gates.cancel),'accepted cancellable navigation');
    await evaluate(true,"document.getElementById('sink').remove();true");
    await until(()=>page.evaluate(()=>navigationLifetime.gates.cancel.signal.aborted),'destination cancellation');
    if(!await actor.evaluate(()=>sandstone_frame.context.run_script('window.ready===true')))throw new Error('Cancelling the destination destroyed the initiator');
    const root=page.frames().find(frame=>frame.parentFrame()===page.mainFrame());
    const invalid=await root.evaluate(async url=>{
      const {rpc,loader}=sandstone_frame,source={document:loader.beacon_context,frame:loader.frame_id,url:loader.url},errors=[];
      for(const [index,mode,snapshot] of [[0,'cors',source],[1,'navigate',{...source,document:'unknown'}],[2,'navigate',{...source,url}]]){
        try{await rpc.call_procedure(rpc.host,'fetch',[loader.frame_id,'invalid-source-'+index,url,{mode},snapshot]);errors.push('accepted');}
        catch(error){errors.push(error.name);}
      }
      return errors;
    },b+'/life/forged');
    if(JSON.stringify(invalid)!==JSON.stringify(['TypeError','TypeError','TypeError']))throw new Error('Invalid navigation context reached transport: '+JSON.stringify(invalid));
    return ['Accepted targeted navigation survives removal or replacement of its initiator','Destination requests retain the original source URL, policy, Origin and form payload','Removing the destination still cancels its navigation without destroying the initiator','Navigation context overrides require an authorized document and navigation request'];
  }finally{await native.close();}
}
