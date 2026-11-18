async page=>{
  const origin='https://lifecycle-events.test',html='<!doctype html><body><p>Lifecycle fixture</p>';
  // Keep the native baseline independent of the proxy context's denied-storage
  // simulation: the proxy must still provide these APIs from its memory store.
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',headers:{'Permissions-Policy':'unload=(self)'},body:html}));
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const cases=[
    ['storage remains active after synthetic unload',`localStorage.setItem('lifecycle-local','before');sessionStorage.setItem('lifecycle-session','before');const seen=[];addEventListener('unload',event=>seen.push([event.isTrusted,event.target===window]));dispatchEvent(new Event('unload'));localStorage.setItem('lifecycle-local','after');sessionStorage.setItem('lifecycle-session','after');result={seen,local:localStorage.getItem('lifecycle-local'),session:sessionStorage.getItem('lifecycle-session')};`],
    ['synthetic events preserve native author listener semantics',`let once=0,always=0,property=0;addEventListener('unload',()=>once++,{once:true});addEventListener('unload',()=>always++);window.onunload=()=>property++;for(let index=0;index<3;index++)dispatchEvent(new Event('unload'));localStorage.setItem('lifecycle-repeat','active');result={once,always,property,local:localStorage.getItem('lifecycle-repeat')};`],
    ['new same-origin frames retain shared data after synthetic unload',`dispatchEvent(new Event('unload'));const frame=document.createElement('iframe');document.body.append(frame);const doc=frame.contentDocument;doc.defaultView.localStorage.setItem('lifecycle-child','shared');doc.defaultView.sessionStorage.setItem('lifecycle-child-session','shared');doc.cookie='lifecycle_child_cookie=shared; Path=/';const local=localStorage.getItem('lifecycle-child'),session=sessionStorage.getItem('lifecycle-child-session'),childCookie=doc.cookie.split('; ').includes('lifecycle_child_cookie=shared'),end=Date.now()+1000;while(!document.cookie.split('; ').includes('lifecycle_child_cookie=shared')&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));result={local,session,childCookie,cookie:document.cookie.split('; ').includes('lifecycle_child_cookie=shared')};frame.remove();`],
    ...['beforeunload','unload'].map(type=>['workers remain active after synthetic '+type,`const url=URL.createObjectURL(new Blob(['onmessage=event=>postMessage(event.data)'],{type:'text/javascript'})),worker=new Worker(url),messages=[];const echo=(value,timeout=1000)=>new Promise(resolve=>{const timer=setTimeout(()=>resolve('timeout'),timeout);worker.onmessage=event=>{clearTimeout(timer);resolve(event.data)};worker.postMessage(value)});try{messages.push(await echo('ready',5000));dispatchEvent(new Event('${type}',{cancelable:true}));messages.push(await echo('first'));dispatchEvent(new Event('${type}',{cancelable:true}));messages.push(await echo('second'));result=messages;}finally{worker.terminate();URL.revokeObjectURL(url);}`])
  ];
  try{
    await page.evaluate(({origin,html})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(url,options)=>new URL(url).origin===origin?Promise.resolve(new Response(html,{headers:{'Content-Type':'text/html','Permissions-Policy':'unload=(self)'}})):previous(url,options);},{origin,html});
    const differences=[];
    for(const [name,source] of cases){
      const outcomes=[];
      for(const proxy of [false,true]){
        if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');else await native.goto(origin+'/start');
        outcomes.push(JSON.parse(await evaluate(proxy,`(async()=>{let result;try{${source};return JSON.stringify({result})}catch(error){return JSON.stringify({error:error.name})}})()`)));
      }
      if(outcomes[0].error||JSON.stringify(outcomes[0])!==JSON.stringify(outcomes[1]))differences.push({name,expected:outcomes[0],actual:outcomes[1]});
    }
    if(differences.length)throw new Error('Lifecycle event parity: '+JSON.stringify(differences));
    return ['Synthetic lifecycle events preserve storage, worker connections and same-origin frame data','Page unload handlers retain native once, property-handler and trust semantics'];
  }finally{await context.close();}
}
