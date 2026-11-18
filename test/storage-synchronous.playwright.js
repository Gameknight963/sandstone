async page=>{
  const base='https://storage-synchronous.test/',html='<!doctype html><body>Shared storage';
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route(base+'**',route=>route.fulfill({contentType:'text/html',body:html}));
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const run=async proxy=>{
    if(proxy)await page.evaluate(async({base,html})=>{main_frame.special_pages[base]=html;await main_frame.navigate_to(base);},{base,html});else await native.goto(base);
    const result=JSON.parse(await evaluate(proxy,`(async()=>{
      localStorage.clear();sessionStorage.clear();
      const blank=document.createElement('iframe');document.body.append(blank);
      blank.contentWindow.localStorage.setItem('startup','blank');localStorage.setItem('startup','parent');
      const startup=[localStorage.getItem('startup'),blank.contentWindow.localStorage.getItem('startup')];
      const loaded=document.createElement('iframe');loaded.src=${JSON.stringify(base+'child')};
      const ready=new Promise(resolve=>loaded.onload=resolve);document.body.append(loaded);await ready;
      const result=[{startup,registered:localStorage.getItem('startup')}];
      for(const area of ['localStorage','sessionStorage']){
        const parent=window[area],left=blank.contentWindow[area],right=loaded.contentWindow[area],reads=[];
        parent.setItem('shared','parent');reads.push(left.getItem('shared'),right.getItem('shared'));
        left.setItem('shared','blank');reads.push(parent.getItem('shared'),right.getItem('shared'));
        right.setItem('shared','loaded');reads.push(parent.getItem('shared'),left.getItem('shared'));
        left.removeItem('shared');reads.push(parent.getItem('shared'),right.getItem('shared'));
        parent.setItem('counter','0');
        for(let index=0;index<12;index++){const store=index%2?left:right;store.setItem('counter',String(Number(store.getItem('counter'))+1));}
        reads.push(parent.getItem('counter'),left.getItem('counter'),right.getItem('counter'));
        right.clear();reads.push(parent.length,left.length,right.length);
        left.setItem('final','saved');reads.push(parent.final,right.final,Object.keys(right).join(','));
        result.push({area,reads,distinct:parent!==left&&left!==right});
      }
      for(const area of ['localStorage','sessionStorage']){
        window[area].setItem('durable-counter','0');
        for(let index=0;index<12;index++){
          const store=(index%2?blank:loaded).contentWindow[area];
          store.setItem('durable-counter',String(Number(store.getItem('durable-counter'))+1));
        }
      }
      const detached={local:blank.contentWindow.localStorage,session:blank.contentWindow.sessionStorage};blank.remove();
      for(const [kind,area] of [['local','localStorage'],['session','sessionStorage']]){
        const storage=detached[kind],checks=[];
        for(const operation of [()=>storage.getItem('final'),()=>storage.setItem('detached','retained'),()=>storage.length,()=>storage.key(0),()=>storage.removeItem('final'),()=>storage.clear(),()=>storage.final,()=>{storage.named='value';},()=>Object.keys(storage),()=>('final' in storage)]){
          try{checks.push({value:operation()??null});}catch(error){checks.push({error:error.name});}
        }
        result.push({kind,checks,after:window[area].getItem('detached')});
      }
      const transient=document.createElement('iframe');document.body.append(transient);
      transient.contentWindow.localStorage.setItem('transient','accepted');transient.remove();
      localStorage.setItem('after-transient','saved');
      await new Promise(resolve=>setTimeout(resolve,150));
      result.push({settled:{local:Object.entries(localStorage).sort(),session:Object.entries(sessionStorage).sort()}});
      blank.remove();loaded.remove();return JSON.stringify(result);
    })()`));
    if(proxy){
      const deadline=Date.now()+5000;
      while(!await evaluate(true,`Object.values(sandstone_frame.storage_sync.storage_group(location.origin).areas).every(area=>area.pending.length===0)`)){
        if(Date.now()>deadline)throw new Error('Shared storage writes did not commit');await new Promise(resolve=>setTimeout(resolve,20));
      }
      await page.evaluate(base=>main_frame.navigate_to(base),base);
    }else await native.goto(base);
    result.push({reloaded:JSON.parse(await evaluate(proxy,'JSON.stringify({local:Object.entries(localStorage).sort(),session:Object.entries(sessionStorage).sort()})'))});
    return result;
  };
  try{
    const expected=await run(false);
    await page.evaluate(({base,html})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(url,options)=>String(url).startsWith(base)?Promise.resolve(new Response(html,{headers:{'Content-Type':'text/html'}})):previous(url,options);},{base,html});
    const actual=await run(true);
    if(JSON.stringify(actual)!==JSON.stringify(expected)){console.log(JSON.stringify({synchronousStorage:{expected,actual}}));throw new Error('Synchronous shared storage differs from native');}
    return ['Same-origin blank and loaded frames share Web Storage writes synchronously','Alternating frame writes, removals, clears and enumeration retain native order'];
  }finally{await context.close();}
}
