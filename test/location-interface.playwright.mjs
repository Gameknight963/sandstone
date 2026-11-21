import assert from 'node:assert/strict';

export async function verifyLocationInterface(page){
  const context=await page.context().browser().newContext(),native=await context.newPage(),fixture=await page.context().newPage();
  const origin='https://location-interface.test',other='https://location-other.test',errors=[],direct=[];
  const html=url=>new URL(url).pathname==='/root'?'<!doctype html><base href="/parent-assets/"><body>Parent':'<!doctype html><base href="/child-assets/"><body>Child';
  const charset=url=>new URL(url).pathname==='/root'?'windows-1252':'UTF-8';
  const run=async()=>{
    const capture=operation=>{try{return {value:operation()??null};}catch(error){return {error:error.name};}};
    const describe=object=>Reflect.ownKeys(object).map(key=>[String(key),Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptor(object,key)).map(([name,value])=>[name,typeof value==='function'?{name:value.name,length:value.length}:value]))]);
    const result={instance:location instanceof Location,prototype:Object.getPrototypeOf(location)===Location.prototype,constructor:location.constructor===Location,tag:Object.prototype.toString.call(location),descriptors:describe(location)};
    const getter=Object.getOwnPropertyDescriptor(location,'href').get,setter=Object.getOwnPropertyDescriptor(location,'href').set;
    let coercions=0;const argument={toString(){coercions++;return '?currency=€';}};
    result.invalid=[capture(()=>location.toString.call({href:'fake'})),capture(()=>getter.call({})),capture(()=>setter.call({},argument)),capture(()=>location.assign()),capture(()=>location.replace()),capture(()=>new Location()),capture(()=>structuredClone(location)),capture(()=>location.assign('http://['))];
    result.badCoercions=coercions;
    result.immutable=[Reflect.set(location,'assign',()=>{}),Reflect.defineProperty(location,'replace',{value(){}}),Reflect.deleteProperty(location,'toString'),Reflect.setPrototypeOf(location,{})];
    const create=async(url,sandbox)=>{const child=document.createElement('iframe');if(sandbox!==undefined)child.sandbox=sandbox;await new Promise(resolve=>{child.onload=resolve;child.src=url;document.body.append(child);});return child;};
    const child=await create('https://location-interface.test/child'),peer=child.contentWindow,owned=child.contentDocument.location;
    result.foreign={instance:owned instanceof peer.Location,rootInstance:owned instanceof Location,href:getter.call(owned),string:location.toString.call(peer.location)};
    const change=async operation=>{await new Promise(resolve=>{child.onload=resolve;operation();});return peer.location.href;};
    result.borrowedAssign=await change(()=>location.assign.call(owned,argument));
    result.borrowedSetter=await change(()=>setter.call(child.contentDocument.location,argument));
    result.coercions=coercions;
    result.borrowedHash=capture(()=>{Object.getOwnPropertyDescriptor(location,'hash').set.call(peer.location,'borrowed');return peer.location.href;});
    const old=child.contentDocument.location,oldHref=old.href;
    await change(()=>{child.src='https://location-interface.test/replacement';});
    coercions=0;
    result.retired={href:getter.call(old),oldHref,assign:capture(()=>location.assign.call(old,argument)),replace:capture(()=>location.replace.call(old,argument)),reload:capture(()=>location.reload.call(old)),symbol:capture(()=>location.assign.call(old,Symbol())),setter:capture(()=>setter.call(old,Symbol())),coercions,current:peer.location.href};
    const cross=await create('https://location-other.test/child');coercions=0;
    result.cross={assign:capture(()=>location.assign.call(cross.contentWindow.location,argument)),missing:capture(()=>location.assign.call(cross.contentWindow.location)),href:capture(()=>getter.call(cross.contentWindow.location)),hash:capture(()=>Object.getOwnPropertyDescriptor(location,'hash').set.call(cross.contentWindow.location,argument)),coercions};
    child.remove();cross.remove();
    result.extensibility={prevent:Reflect.preventExtensions(location),extensible:Object.isExtensible(location),samePrototype:Reflect.setPrototypeOf(location,Location.prototype)};
    return JSON.stringify(result);
  };
  try{
    for(const surface of [native,fixture])surface.on('pageerror',error=>errors.push(error.message));
    await native.route(/^https:\/\/location-(?:interface|other)\.test\//,route=>route.fulfill({contentType:'text/html;charset='+charset(route.request().url()),body:html(route.request().url())}));
    await native.goto(origin+'/root');
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.evaluate(({html,charset})=>{
      const render=(0,eval)('('+html+')'),encoding=(0,eval)('('+charset+')');main_frame.on_load=()=>{};
      sandstone.network.session.fetch=async url=>new Response(render(url),{headers:{'content-type':'text/html;charset='+encoding(url),'cache-control':'no-store'}});
    },{html:html.toString(),charset:charset.toString()});
    await fixture.evaluate(url=>main_frame.navigate_to(url),origin+'/root');
    const expected=JSON.parse(await native.evaluate(run));
    const actual=JSON.parse(await fixture.evaluate(source=>main_frame.eval_js(source),'('+run.toString()+')()'));
    assert.deepEqual(actual,expected);
    assert.equal(actual.borrowedAssign,origin+'/parent-assets/?currency=%80');assert.equal(actual.borrowedSetter,actual.borrowedAssign);
    assert.equal(actual.badCoercions,0);assert.equal(actual.coercions,2);assert.equal(actual.cross.coercions,0);
    assert.equal(actual.retired.coercions,2);assert.equal(actual.retired.href,actual.retired.oldHref);assert.equal(actual.retired.current,origin+'/replacement');
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
  }finally{await fixture.close();await context.close();}
  return ['Location exposes native branding, unforgeable own methods, receiver checks and prototype restrictions','Borrowed Location methods and setters retain the source base and encoding, cross-origin checks and retired-document behavior'];
}

export async function verifyBorrowedLocationSandbox(page){
  const context=await page.context().browser().newContext(),native=await context.newPage(),fixture=await page.context().newPage();
  const origin='https://location-sandbox.test',errors=[],direct=[];
  const html=(url,sandbox)=>{
    if(new URL(url).pathname==='/child')return '<!doctype html><script>let coercions=0;const value={toString(){coercions++;return "https://location-sandbox.test/root#borrowed";}};let result;try{location.replace.call(parent.document.location,value);result="allowed";}catch(error){result=error.name;}parent.postMessage({result,coercions},"*");</script>';
    return '<!doctype html><script>onmessage=e=>{if(e.data?.result)globalThis.borrowedResult=e.data;};</script><iframe sandbox="'+sandbox+'" src="/child"></iframe>';
  };
  let current;
  const read=(proxy,source)=>proxy?fixture.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  try{
    for(const surface of [native,fixture])surface.on('pageerror',error=>errors.push(error.message));
    await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:html(route.request().url(),current)}));
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.evaluate(html=>{const render=(0,eval)('('+html+')');main_frame.on_load=()=>{};sandstone.network.session.fetch=async url=>new Response(render(url,locationSandbox),{headers:{'content-type':'text/html','cache-control':'no-store'}});},html.toString());
    for(const sandbox of ['allow-scripts allow-same-origin','allow-scripts allow-same-origin allow-top-navigation']){
      current=sandbox;const results=[];
      for(const proxy of [false,true]){
        if(proxy){await fixture.evaluate(sandbox=>{globalThis.locationSandbox=sandbox;},sandbox);await fixture.evaluate(url=>main_frame.navigate_to(url),origin+'/root');}else await native.goto(origin+'/root');
        const deadline=Date.now()+8000;while(!await read(proxy,'!!globalThis.borrowedResult')){if(Date.now()>deadline)throw new Error('Borrowed Location sandbox navigation did not complete');await fixture.waitForTimeout(10);}
        results.push(JSON.parse(await read(proxy,'JSON.stringify({result:borrowedResult,hash:location.hash})')));
      }
      assert.deepEqual(results[1],results[0]);assert.equal(results[0].result.coercions,1);
      assert.equal(results[0].result.result,sandbox.includes('allow-top-navigation')?'allowed':'SecurityError');
    }
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
  }finally{await fixture.close();await context.close();}
  return ['Borrowing a Location method cannot bypass the source frame sandbox navigation policy'];
}

export async function verifySiblingLocationBorrowing(page){
  const context=await page.context().browser().newContext(),native=await context.newPage(),fixture=await page.context().newPage();
  const origin='https://location-siblings.test',errors=[],direct=[];
  const html=url=>new URL(url).pathname==='/left'?'<base href="/left-base/"><script>onmessage=event=>{if(!event.data?.go)return;let conversions=0;const value={toString(){conversions++;return "?euro=\\u20ac";}};let outcome;try{location.assign.call(parent.document.getElementById("right-sibling").contentDocument.location,value);outcome="allowed";}catch(error){outcome=error.name;}parent.postMessage({siblingDone:true,outcome,conversions},"*");};</script>':'<!doctype html><body>Location siblings';
  const run=async(sandboxed,blank)=>{
    const create=async(path,sandbox)=>{const frame=document.createElement('iframe');if(sandbox)frame.sandbox='allow-scripts allow-same-origin';await new Promise(resolve=>{frame.onload=resolve;frame.src=path;document.body.append(frame);});return frame;};
    const left=await create('/left',sandboxed),right=blank?document.createElement('iframe'):await create('/right');
    right.id='right-sibling';
    let done;const loaded=new Promise(resolve=>{done=resolve;});
    right.onload=()=>{if(right.contentWindow.location.href.includes('/left-base/'))done();};
    if(blank)document.body.append(right);
    let reply;const received=new Promise(resolve=>{reply=resolve;});
    const listener=event=>{if(event.data?.siblingDone)reply(event.data);};addEventListener('message',listener);
    let timer;const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Sibling Location navigation timed out')),8000);});
    try{
      left.contentWindow.postMessage({go:true},'*');
      const {outcome,conversions}=await Promise.race([received,deadline]);
      if(outcome==='allowed')await Promise.race([loaded,deadline]);
      return JSON.stringify({outcome,conversions,url:right.contentWindow.location.href});
    }finally{clearTimeout(timer);removeEventListener('message',listener);left.remove();right.remove();}
  };
  try{
    for(const surface of [native,fixture])surface.on('pageerror',error=>errors.push(error.message));
    await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html;charset=windows-1252',body:html(route.request().url())}));
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.evaluate(html=>{const render=(0,eval)('('+html+')');main_frame.on_load=()=>{};sandstone.network.session.fetch=async url=>new Response(render(url),{headers:{'content-type':'text/html;charset=windows-1252','cache-control':'no-store'}});},html.toString());
    for(const [sandboxed,blank] of [[false,false],[false,true],[true,false]]){
      await native.goto(origin+'/root');await fixture.evaluate(url=>main_frame.navigate_to(url),origin+'/root');
      const expected=JSON.parse(await native.evaluate(({source,sandboxed,blank})=>eval('('+source+')')(sandboxed,blank),{source:run.toString(),sandboxed,blank}));
      const actual=JSON.parse(await fixture.evaluate(source=>main_frame.eval_js(source),'('+run.toString()+')('+sandboxed+','+blank+')'));
      assert.deepEqual(actual,expected);assert.equal(actual.conversions,1);
      assert.equal(actual.outcome,sandboxed?'SecurityError':'allowed');assert.equal(actual.url,origin+(sandboxed?'/right':'/left-base/?euro=%80'));
    }
    await fixture.evaluate(url=>main_frame.navigate_to(url),origin+'/root');
    await fixture.evaluate(()=>{
      const target=main_frame.rpc_target,receive=target.onmessage;
      const state=globalThis.locationReadinessHold={target,receive,held:[]};
      target.onmessage=function(event,...args){
        const message=event.data;
        if(message?.type==='procedure'&&message.procedure==='cookies_ready'&&message.arguments[0]!==main_frame.id){
          state.first??=message.arguments[0];
          if(message.arguments[0]!==state.first&&!state.held.length){state.held.push({event:{data:message,source:event.source||event.currentTarget,ports:event.ports},args});return;}
        }
        return receive.call(this,event,...args);
      };
    });
    try{
      const waiting=fixture.evaluate(source=>main_frame.eval_js(source),'('+run.toString()+')(false,true)');waiting.catch(()=>{});
      await fixture.waitForFunction(()=>locationReadinessHold.held.length===1);
      const result=JSON.parse(await waiting);
      assert.equal(result.url,origin+'/left-base/?euro=%80','A pending cookie snapshot blocked sibling navigation');
    }finally{
      await fixture.evaluate(async()=>{const state=locationReadinessHold;state.target.onmessage=state.receive;for(const {event,args} of state.held)await state.receive.call(state.target,event,...args);delete globalThis.locationReadinessHold;});
    }
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
  }finally{await fixture.close();await context.close();}
  return ['Same-origin sibling Location borrowing preserves source URL encoding, blank-frame readiness and sandbox restrictions','Pending blank-frame cookie readiness cannot block a sibling Location navigation'];
}
