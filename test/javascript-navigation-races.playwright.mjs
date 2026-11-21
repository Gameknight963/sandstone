import assert from 'node:assert/strict';

export async function verifyJavascriptNavigationRaces(page){
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage(),fixture=await page.context().newPage();
  const origin='https://javascript-races.test',errors=[],direct=[];
  const parentHTML='<!doctype html><body><script>globalThis.childLoads=0;globalThis.staleMessages=[];globalThis.replacementReport=null;addEventListener("message",event=>{if(event.data==="stale")staleMessages.push(event.data);if(event.data?.replacement)replacementReport={...event.data,messageOrigin:event.origin};});</script>';
  const replacement='<!doctype html><body>Replacement<script>globalThis.replacementLoaded=true;parent.postMessage({replacement:true,url:location.href,origin},"*");</script>';
  const stalled='<!doctype html><script src="/held.js"></script><body>Old document';
  let held;
  for(const surface of [native,fixture])surface.on('pageerror',error=>errors.push(error.message));
  try{
    await native.route(origin+'/**',async route=>{
      const pathname=new URL(route.request().url()).pathname;
      if(pathname==='/held.js'){
        const request=held;request.started=true;await request.promise;
        try{await route.fulfill({contentType:'text/javascript',body:'parent.postMessage("stale","*");'});}catch{}
        request.finished=true;return;
      }
      await route.fulfill({contentType:'text/html',body:pathname==='/replacement'?replacement:pathname==='/loading'?stalled:parentHTML});
    });
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.evaluate(({parentHTML,replacement,stalled})=>{
      main_frame.on_load=()=>{};
      sandstone.network.session.fetch=async url=>{
        const pathname=new URL(url).pathname;
        if(pathname==='/held.js'){
          const request=javascriptHeld;request.started=true;await request.promise;request.finished=true;
          return new Response('parent.postMessage("stale","*");',{headers:{'content-type':'text/javascript'}});
        }
        return new Response(pathname==='/replacement'?replacement:pathname==='/loading'?stalled:parentHTML,{headers:{'content-type':'text/html'}});
      };
    },{parentHTML,replacement,stalled});
    const read=(proxy,source)=>proxy?fixture.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
    const wait=async(predicate,label)=>{
      const deadline=Date.now()+8000;
      while(!await predicate()){
        if(Date.now()>deadline)throw new Error(label);
        await fixture.waitForTimeout(20);
      }
    };
    for(const kind of ['http','javascript','loading-javascript','opened-javascript','before-execution']){
      const results=[];
      // Chromium can put document.open's returned initial document in a
      // different agent cluster and block a later same-origin parent JS URL.
      // Assert the relay's logical same-origin behavior independently here.
      for(const proxy of kind==='opened-javascript'?[true]:[false,true]){
        console.log(JSON.stringify({fixture:'JavaScript navigation cancellation',kind,proxy}));
        if(proxy){
          await fixture.evaluate(()=>{let release;globalThis.javascriptHeld={started:false,finished:false,promise:new Promise(resolve=>{release=resolve;}),release:()=>release()};});
          await fixture.evaluate(url=>main_frame.navigate_to(url),origin+'/start');
        }else{
          let release;held={started:false,finished:false,promise:new Promise(resolve=>{release=resolve;}),release:()=>release()};
          await native.goto(origin+'/start');
        }
        const first=kind==='loading-javascript'?origin+'/loading':'javascript:'+encodeURIComponent((kind==='before-execution'?'parent.postMessage("stale","*");':kind==='opened-javascript'?'document.open();':'')+JSON.stringify(stalled));
        const next=kind.endsWith('javascript')?'javascript:'+encodeURIComponent(JSON.stringify(replacement)):origin+'/replacement';
        await read(proxy,'globalThis.child=document.createElement("iframe");child.onload=()=>childLoads++;child.src='+JSON.stringify(first)+';document.body.append(child);'+(kind==='before-execution'?'child.src='+JSON.stringify(next)+';':'')+'true');
        if(kind!=='before-execution'){
          await wait(()=>proxy?fixture.evaluate(()=>javascriptHeld.started):held.started,'The original JavaScript result never requested its held script');
          await read(proxy,'child.src='+JSON.stringify(next)+';true');
        }
        await wait(()=>read(proxy,'!!replacementReport').catch(()=>false),'The replacement waited for the superseded script: '+JSON.stringify({kind,proxy}));
        if(proxy)await fixture.evaluate(()=>javascriptHeld.release());else held.release();
        if(kind!=='before-execution')await wait(()=>proxy?fixture.evaluate(()=>javascriptHeld.finished):held.finished,'The held transport did not finish after release');
        await fixture.waitForTimeout(100);
        const snapshot=JSON.parse(await read(proxy,'JSON.stringify({report:replacementReport,src:child.getAttribute("src"),loads:childLoads,stale:staleMessages.length,readable:(()=>{try{return !!child.contentWindow.document;}catch{return false;}})()})'));
        console.log(JSON.stringify({fixture:'JavaScript navigation result',kind,proxy,report:snapshot.report,loads:snapshot.loads,stale:snapshot.stale,readable:snapshot.readable}));results.push(snapshot);
      }
      if(kind==='opened-javascript'){
        assert.deepEqual(results[0],{report:{replacement:true,url:'about:blank',origin,messageOrigin:origin},src:'javascript:'+encodeURIComponent(JSON.stringify(replacement)),loads:1,stale:0,readable:true},kind);
        continue;
      }
      // Chromium 159 can change an initial JavaScript result's agent-cluster
      // setting on the next result, despite keeping its tuple and message
      // origins. Native WindowProxy reads then fail between these equal
      // origins. Compare navigation through messages and keep the proxy's
      // logical same-origin access, as required by the HTML origin model:
      // https://html.spec.whatwg.org/multipage/browsers.html#origin-keyed-agent-clusters
      const {readable:nativeReadable,...expected}=results[0],{readable:proxyReadable,...actual}=results[1];
      assert.deepEqual(actual,expected,kind);
      assert.equal(proxyReadable,true,kind);if(!kind.endsWith('javascript'))assert.equal(nativeReadable,true,kind);
      assert.equal(results[0].stale,0,kind);assert.equal(results[0].loads,1,kind);
    }
    assert.deepEqual(direct,[],'JavaScript navigation cancellation made a direct HTTP request');
    assert.deepEqual(errors,[],'JavaScript navigation cancellation raised a script error');
  }finally{held?.release();await fixture.close();await nativeContext.close();}
  return ['HTTP and JavaScript replacements supersede stalled iframe documents without waiting for abandoned scripts','JavaScript URLs superseded before execution cannot run stale programs or leak bootstrap URLs'];
}
