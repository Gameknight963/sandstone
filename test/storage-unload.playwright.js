async page=>{
  const origin='https://storage-unload.test',other='https://storage-unload-other.test',html='<!doctype html><body>Storage unload fixture';
  const context=await page.context().browser().newContext(),native=await context.newPage();
  for(const host of [origin,other])await context.route(host+'/**',route=>route.fulfill({contentType:'text/html',headers:{'Permissions-Policy':'unload=(self)'},body:html}));
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const until=async operation=>{const end=Date.now()+10000;while(!await operation()){if(Date.now()>end)return false;await new Promise(resolve=>setTimeout(resolve,20));}return true;};
  const cases=[
    ['child removal writes',`const frame=await createChild(),child=frame.contentWindow,local=child.localStorage,session=child.sessionStorage,events=[];child.addEventListener('unload',event=>{try{local.setItem('exit-local','saved');session.setItem('exit-session','saved');events.push({trusted:event.isTrusted,local:local.getItem('exit-local'),session:session.getItem('exit-session'),parent:localStorage.getItem('exit-local')})}catch(error){events.push({error:error.name})}});frame.remove();result={events,local:localStorage.getItem('exit-local'),session:sessionStorage.getItem('exit-session'),detached:[capture(()=>local.getItem('exit-local')),capture(()=>session.setItem('late','rejected'))]};`],
    ['borrowed writes and property mutations',`const frame=await createChild(),child=frame.contentWindow,local=child.localStorage,session=child.sessionStorage,events=[];child.onunload=()=>{try{Storage.prototype.setItem.call(local,'borrowed','saved');session.property='value';delete session.old;events.push({local:Storage.prototype.getItem.call(local,'borrowed'),session:session.property,keys:Object.keys(session)})}catch(error){events.push({error:error.name})}};session.old='old';frame.remove();result={events,local:localStorage.getItem('borrowed'),session:sessionStorage.property,old:sessionStorage.getItem('old')};`],
    ['clear and write during unload',`const frame=await createChild(),child=frame.contentWindow,local=child.localStorage,session=child.sessionStorage,events=[];local.setItem('old','old');session.setItem('old','old');child.addEventListener('unload',()=>{try{local.clear();session.clear();local.setItem('final','local');session.setItem('final','session');events.push([local.length,session.length])}catch(error){events.push({error:error.name})}});frame.remove();result={events,local:[...Object.keys(localStorage)].sort(),session:[...Object.keys(sessionStorage)].sort(),values:[localStorage.getItem('final'),sessionStorage.getItem('final')]};`],
    ['child navigation writes stay at the original origin',`const frame=await createChild(),child=frame.contentWindow,local=child.localStorage,session=child.sessionStorage,events=[];child.addEventListener('unload',()=>{try{local.setItem('navigated','local');session.setItem('navigated','session');events.push('saved')}catch(error){events.push(error.name)}});const done=new Promise(resolve=>frame.onload=resolve);frame.src='${other}/child';await done;result={events,local:localStorage.getItem('navigated'),session:sessionStorage.getItem('navigated'),detached:capture(()=>local.getItem('navigated'))};frame.remove();`],
    ['deferred writes cannot revive detached storage',`const frame=await createChild(),child=frame.contentWindow,local=child.localStorage,events=[];child.addEventListener('unload',()=>{local.setItem('during','saved');queueMicrotask(()=>events.push(capture(()=>local.setItem('late','rejected'))))});frame.remove();await Promise.resolve();result={events,during:localStorage.getItem('during'),late:localStorage.getItem('late')};`],
    ['synthetic replay cannot revive detached storage',`const frame=await createChild(),child=frame.contentWindow,local=child.localStorage,events=[];let saved;child.addEventListener('unload',event=>{saved=event;local.setItem('during','saved');events.push('saved')});frame.remove();const before=capture(()=>local.setItem('late','rejected')),replay=capture(()=>dispatchEvent(saved)),after=capture(()=>local.setItem('late','rejected'));result={events,before,replay,after,late:localStorage.getItem('late')};`]
  ];
  try{
    await page.evaluate(({origin,other,html})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(url,options)=>[origin,other].includes(new URL(url).origin)?Promise.resolve(new Response(html,{headers:{'Content-Type':'text/html','Permissions-Policy':'unload=(self)'}})):previous(url,options);},{origin,other,html});
    const differences=[];
    for(const [name,source] of cases){
      const outcomes=[];
      for(const proxy of [false,true]){
        if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');else await native.goto(origin+'/start');
        outcomes.push(JSON.parse(await evaluate(proxy,`(async()=>{localStorage.clear();sessionStorage.clear();const capture=operation=>{try{return {value:operation()??null}}catch(error){return {error:error.name}}},createChild=()=>new Promise(resolve=>{const frame=document.createElement('iframe');frame.allow='unload';frame.onload=()=>resolve(frame);frame.src='${origin}/child';document.body.append(frame)});let result;try{${source};return JSON.stringify({result})}catch(error){return JSON.stringify({error:error.name})}})()`)));
      }
      if(outcomes[0].error||!outcomes[0].result?.events?.length||JSON.stringify(outcomes[0])!==JSON.stringify(outcomes[1]))differences.push({name,expected:outcomes[0],actual:outcomes[1]});
    }
    const persisted=[];
    for(const proxy of [false,true]){
      if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),origin+'/save');else await native.goto(origin+'/save');
      await evaluate(proxy,`localStorage.clear();sessionStorage.clear();addEventListener('unload',()=>{try{localStorage.setItem('navigation-exit','local');sessionStorage.setItem('navigation-exit','session')}catch{}});true`);
      if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),other+'/destination');else await native.goto(other+'/destination');
      const destination=JSON.parse(await evaluate(proxy,'JSON.stringify({local:localStorage.getItem("navigation-exit"),session:sessionStorage.getItem("navigation-exit")})'));
      if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),origin+'/return');else await native.goto(origin+'/return');
      const settled=await until(()=>evaluate(proxy,'localStorage.getItem("navigation-exit")==="local"&&sessionStorage.getItem("navigation-exit")==="session"').catch(()=>false));
      persisted.push({settled,destination,returned:JSON.parse(await evaluate(proxy,'JSON.stringify({local:localStorage.getItem("navigation-exit"),session:sessionStorage.getItem("navigation-exit")})'))});
    }
    if(!persisted[0].settled||JSON.stringify(persisted[0])!==JSON.stringify(persisted[1]))differences.push({name:'navigation persistence',expected:persisted[0],actual:persisted[1]});
    if(differences.length)throw new Error('Unload storage parity: '+JSON.stringify(differences));
    return ['Unload handlers retain native storage reads, writes, enumeration and borrowed methods','Unload writes persist at the original origin while detached storage references remain unavailable'];
  }finally{await context.close();}
}
