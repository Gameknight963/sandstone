async page=>{
  const source=`(async()=>{
    const pause=()=>new Promise(resolve=>setTimeout(resolve,20)),results=[];
    const link=(name,parent=document.body)=>{const a=document.createElement('a');a.href='#'+name;a.textContent=name;parent.append(a);return a;};
    const reset=()=>history.replaceState(null,'','#start');
    const run=async(name,setup)=>{
      reset();const a=link(name),seen=[];
      const cleanup=setup(a,seen)||(()=>{});
      const event=new MouseEvent('click',{bubbles:true,cancelable:true,composed:true});
      const dispatched=a.dispatchEvent(event);await pause();
      results.push({name,seen,dispatched,canceled:event.defaultPrevented,returned:event.returnValue,hash:location.hash});
      cleanup();a.remove();
    };
    await run('document',(a,seen)=>{
      const route=e=>{if(e.target!==a)return;seen.push(['document',e.defaultPrevented]);e.preventDefault();};
      const observe=e=>{if(e.target===a)seen.push(['window',e.defaultPrevented]);};
      document.addEventListener('click',route);window.addEventListener('click',observe);
      return ()=>{document.removeEventListener('click',route);window.removeEventListener('click',observe);};
    });
    await run('window',(a,seen)=>{
      const route=e=>{if(e.target===a){seen.push(e.defaultPrevented);e.preventDefault();}};
      window.addEventListener('click',route);return ()=>window.removeEventListener('click',route);
    });
    await run('stopped',(a,seen)=>{a.addEventListener('click',e=>{seen.push(e.defaultPrevented);e.stopPropagation();});});
    await run('immediate',(a,seen)=>{a.addEventListener('click',e=>{seen.push('first');e.stopImmediatePropagation();});a.addEventListener('click',()=>seen.push('unexpected'));});
    await run('return-value',a=>{a.addEventListener('click',e=>{e.returnValue=false;});});
    await run('passive',(a,seen)=>{a.addEventListener('click',e=>{e.preventDefault();seen.push(e.defaultPrevented);},{passive:true});});
    await run('property',(a,seen)=>{const handler=function(e){seen.push(this===a,e.defaultPrevented);return false;};a.onclick=handler;seen.push(a.onclick===handler);});
    await run('removed',a=>{const handler=e=>e.preventDefault();a.addEventListener('click',handler);a.removeEventListener('click',handler);});
    await run('aborted',a=>{const controller=new AbortController();a.addEventListener('click',e=>e.preventDefault(),{signal:controller.signal});controller.abort();});
    await run('duplicate',(a,seen)=>{const handler=e=>{e.preventDefault();seen.push(e.defaultPrevented);};a.addEventListener('click',handler,{passive:true});a.addEventListener('click',handler,{passive:false,signal:AbortSignal.abort()});a.addEventListener('click',handler,{passive:false});});
    await run('options',(a,seen)=>{const options={get capture(){seen.push('capture');return false;},get once(){seen.push('once');return true;},get passive(){seen.push('passive');return false;},get signal(){seen.push('signal');return undefined;}};a.addEventListener('click',e=>e.preventDefault(),options);});
    await run('remove-options',(a,seen)=>{a.removeEventListener('click',()=>{}, {get capture(){seen.push('capture');return false;}});});
    await run('prototype-cancel',a=>{a.addEventListener('click',e=>Event.prototype.preventDefault.call(e));});
    await run('window-property',a=>{window.onclick=e=>e.target===a?false:undefined;return ()=>{window.onclick=null;};});
    reset();const once=link('once');let calls=0;once.addEventListener('click',e=>{calls++;e.preventDefault();},{once:true});
    once.click();await pause();const first=location.hash;once.click();await pause();results.push({name:'once',calls,first,second:location.hash});once.remove();
    reset();const late=link('late');let lateEvent;late.addEventListener('click',e=>{lateEvent=e;});late.click();lateEvent.preventDefault();await pause();
    results.push({name:'late',canceled:lateEvent.defaultPrevented,hash:location.hash});late.remove();
    reset();const reused=link('reuse-first'),event=new MouseEvent('click',{bubbles:true,cancelable:true});
    const firstReturn=reused.dispatchEvent(event);await pause();const firstHash=location.hash;reused.href='#reuse-second';
    const secondReturn=reused.dispatchEvent(event);await pause();results.push({name:'reused',firstReturn,secondReturn,firstHash,hash:location.hash,canceled:event.defaultPrevented});reused.remove();
    reset();const host=document.createElement('div');document.body.append(host);const shadow=host.attachShadow({mode:'closed'}),hidden=link('closed',shadow);
    hidden.addEventListener('click',e=>e.stopPropagation());hidden.click();await pause();results.push({name:'closed',hash:location.hash});host.remove();
    reset();const trusted=link('trusted');trusted.id='trusted-link';trusted.addEventListener('click',e=>{window.trustedSeen=[e.isTrusted,e.defaultPrevented];e.stopPropagation();});
    const plainHost=document.createElement('div');document.body.append(plainHost);
    const plainRoot=plainHost.attachShadow({mode:'closed'});plainRoot.innerHTML='<a href="#trusted-closed">Plain closed shadow link</a>';
    window.closedTrusted=plainRoot.firstElementChild;
    return JSON.stringify(results);
  })()`;
  const native=await page.context().newPage();
  await native.route('https://fixture.test/links/page',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><body>Links'}));
  try{
    await native.goto('https://fixture.test/links/page');
    const expected=JSON.parse(await native.evaluate(source=>eval(source),source));
    await native.locator('#trusted-link').click();
    await native.waitForFunction(()=>location.hash==='#trusted');
    const nativeTrusted=await native.evaluate(()=>({seen:trustedSeen,hash:location.hash}));
    const nativeClosed=await native.evaluateHandle(()=>closedTrusted);await nativeClosed.asElement().click();
    await native.waitForFunction(()=>location.hash==='#trusted-closed');await nativeClosed.dispose();
    await page.evaluate(async()=>{
      const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=(url,options)=>new URL(url).pathname==='/links/page'?Promise.resolve(new Response('<!doctype html><body>Links',{headers:{'Content-Type':'text/html'}})):previous(url,options);
      await main_frame.navigate_to('https://fixture.test/links/page');
    });
    const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),source));
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Link event parity: '+JSON.stringify({expected,actual}));
    const frame=page.frameLocator('iframe[frame-id]');
    await frame.locator('#trusted-link').click();
    await page.waitForFunction(()=>main_frame.url.hash==='#trusted');
    const trusted=JSON.parse(await page.evaluate(()=>main_frame.eval_js('JSON.stringify({seen:trustedSeen,hash:location.hash})')));
    if(JSON.stringify(trusted)!==JSON.stringify(nativeTrusted))throw new Error('Trusted link click differs from native: '+JSON.stringify(trusted));
    let rootFrame;
    for(const candidate of page.frames())if(await candidate.evaluate(()=>globalThis.sandstone_frame?.loader.url?.startsWith('https://fixture.test/links/page')).catch(()=>false)){rootFrame=candidate;break;}
    if(!rootFrame)throw new Error('Missing virtual link frame');
    const closed=await rootFrame.evaluateHandle(()=>sandstone_frame.context.run_script('closedTrusted'));await closed.asElement().click();
    await page.waitForFunction(()=>main_frame.url.hash==='#trusted-closed');await closed.dispose();
    return ['Delegated document/window link routers','Click cancellation, passive listeners and propagation stops','Property handlers, listener removal/abort/once and reused events','Closed shadow links and trusted user activation'];
  }finally{await native.close();}
}
