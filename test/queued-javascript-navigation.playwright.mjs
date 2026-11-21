import assert from 'node:assert/strict';

export async function verifyQueuedJavascriptNavigation(page){
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage(),fixture=await page.context().newPage();
  const origin='https://queued-navigation.test',direct=[],errors=[];
  const parentHTML='<!doctype html><body><script>globalThis.reports=[];addEventListener("message",event=>reports.push(event.data));</script>';
  const replacement='<!doctype html><body>Replacement<script>parent.postMessage({replacement:location.href},"*");</script>';
  const program='javascript:'+encodeURIComponent('parent.postMessage({earlier:true},"*");void 0');
  const nextProgram='javascript:'+encodeURIComponent('parent.postMessage({replacement:location.href},"*");void 0');
  let held,parentFrame;
  const read=(proxy,source)=>proxy?fixture.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const wait=async(predicate,label)=>{
    const deadline=Date.now()+8000;
    while(!await predicate()){
      if(Date.now()>deadline)throw new Error(label);
      await fixture.waitForTimeout(20);
    }
  };
  try{
    for(const surface of [native,fixture])surface.on('pageerror',error=>errors.push(error.message));
    await native.route(origin+'/**',async route=>{
      if(new URL(route.request().url()).pathname==='/replacement'){
        const request=held;request.started=true;await request.promise;
        try{await route.fulfill({contentType:'text/html',body:replacement});}catch{}
      }else await route.fulfill({contentType:'text/html',body:parentHTML});
    });
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    for(const kind of ['href','assign','replace','src','link','srcdoc','remove','javascript','javascript-assign','javascript-replace','javascript-src']){
      const javascript=kind.startsWith('javascript');
      const finalURL=kind==='srcdoc'?'about:srcdoc':javascript?'about:blank':origin+'/replacement';
      const results=[];
      for(const proxy of [false,true]){
        console.log(JSON.stringify({fixture:'Queued JavaScript navigation',kind,proxy}));
        if(proxy){
          await fixture.evaluate(async({origin,parentHTML,replacement})=>{
            main_frame.on_load=()=>{};
            let release;
            globalThis.queuedNavigation={started:false,promise:new Promise(resolve=>{release=resolve;}),release:()=>release()};
            sandstone.network.session.fetch=async url=>{
              if(new URL(url).pathname==='/replacement'){
                queuedNavigation.started=true;await queuedNavigation.promise;
                return new Response(replacement,{headers:{'content-type':'text/html'}});
              }
              return new Response(parentHTML,{headers:{'content-type':'text/html'}});
            };
            await main_frame.navigate_to(origin+'/parent');
            const target=main_frame.rpc_target,receive=target.onmessage,held=[];
            Object.assign(queuedNavigation,{target,receive,held});
            target.onmessage=function(event,...args){
              if(event.data?.type==='procedure'&&['storage_ready','cookies_ready'].includes(event.data.procedure)){
                held.push({event:{data:event.data,source:event.source||event.currentTarget,ports:event.ports},args});return;
              }
              return receive.call(this,event,...args);
            };
          },{origin,parentHTML,replacement});
        }else{
          let release;held={started:false,promise:new Promise(resolve=>{release=resolve;}),release:()=>release()};
          await native.goto(origin+'/parent');
        }
        await read(proxy,'globalThis.child=document.createElement("iframe");child.name="pending-target";document.body.append(child);child.contentWindow;true');
        if(proxy){
          await fixture.waitForFunction(()=>queuedNavigation.held.length===2);
          parentFrame=undefined;
          for(const frame of fixture.frames())if(await frame.evaluate(url=>globalThis.sandstone_frame?.loader.url===url,origin+'/parent').catch(()=>false))parentFrame=frame;
          assert.ok(parentFrame,'The parent runtime did not load');
          // Keep the actual navigation promise so cancellation can be observed
          // without timing assumptions about delayed postMessage delivery.
          await parentFrame.evaluate(url=>{
            const navigate=[...sandstone_frame.loader.child_navigators.values()][0];
            globalThis.queuedProgram=navigate(url,null,{history_mode:'push'});
            globalThis.queuedProgramSettled=false;
            queuedProgram.then(value=>{globalThis.queuedCompletion={value};queuedProgramSettled=true;},error=>{globalThis.queuedCompletion={error:{name:error.name,message:error.message}};queuedProgramSettled=true;});
          },program);
        }
        const url=JSON.stringify(origin+'/replacement');
        const actions={
          href:'child.contentWindow.location.href='+url,
          assign:'child.contentWindow.location.assign('+url+')',
          replace:'child.contentWindow.location.replace('+url+')',
          src:'child.src='+url,
          srcdoc:'child.srcdoc='+JSON.stringify(replacement),
          remove:'child.remove()',
          javascript:'child.contentWindow.location.href='+JSON.stringify(nextProgram),
          'javascript-assign':'child.contentWindow.location.assign('+JSON.stringify(nextProgram)+')',
          'javascript-replace':'child.contentWindow.location.replace('+JSON.stringify(nextProgram)+')',
          'javascript-src':'child.src='+JSON.stringify(nextProgram),
          link:'(()=>{const link=document.createElement("a");link.href='+url+';link.target="pending-target";document.body.append(link);link.click();})()'
        };
        const action=actions[kind];
        if(kind==='javascript-src')await read(proxy,'globalThis.sourceChanges=[];globalThis.sourceObserver=new MutationObserver(records=>{for(const record of records)if(record.attributeName==="src")sourceChanges.push({oldValue:record.oldValue,value:record.target.getAttribute("src")});});sourceObserver.observe(child,{attributes:true,attributeOldValue:true});true');
        await read(proxy,(proxy?'':'child.contentWindow.location.href='+JSON.stringify(program)+';')+action+';true');
        if(['href','assign','replace','src','link'].includes(kind))await wait(()=>proxy?fixture.evaluate(()=>queuedNavigation.started):held.started,'The later HTTP navigation did not start: '+JSON.stringify({kind,proxy}));
        if(proxy){
          if(!javascript){
            await wait(()=>parentFrame.evaluate(()=>queuedProgramSettled),'The superseded program still waited for abandoned readiness: '+kind);
            const completion=await parentFrame.evaluate(()=>queuedCompletion);
            assert.equal(completion.error,undefined,'Cancellation rejected instead of settling: '+kind);
            assert.notEqual(completion.value?.executed,true,'A superseded JavaScript program ran before the later '+kind+' navigation');
          }
          await fixture.evaluate(()=>{
            const state=queuedNavigation;state.target.onmessage=state.receive;
            for(const {event,args} of state.held)state.receive.call(state.target,event,...args);
          });
          if(javascript){
            await wait(()=>parentFrame.evaluate(()=>queuedProgramSettled),'The first JavaScript URL did not finish: '+kind);
            const completion=await parentFrame.evaluate(()=>queuedCompletion);
            assert.equal(completion.value?.executed,true,'A subsequent JavaScript URL incorrectly cancelled its predecessor: '+kind);
          }
          await fixture.evaluate(()=>queuedNavigation.release());
        }else held.release();
        if(kind!=='remove')await wait(()=>read(proxy,'reports.some(report=>report.replacement)'),'The final document did not load: '+JSON.stringify({kind,proxy}));
        const snapshot=JSON.parse(await read(proxy,'JSON.stringify({reports,src:child.getAttribute("src"),url:child.contentWindow?.location.href??null})'));
        if(kind==='javascript-src'){
          const reflected=JSON.parse(await read(proxy,'JSON.stringify({present:child.hasAttribute("src"),property:child.src,node:child.getAttributeNode("src")?.value,named:child.attributes.getNamedItem("src")?.value,identity:child.getAttributeNode("src")?.ownerElement===child&&child.attributes.getNamedItem("src")===child.getAttributeNode("src"),clone:child.cloneNode(false).getAttribute("src"),changes:sourceChanges})'));
          assert.deepEqual(reflected,{present:true,property:nextProgram,node:nextProgram,named:nextProgram,identity:true,clone:nextProgram,changes:[{oldValue:null,value:nextProgram}]},JSON.stringify({kind,proxy}));
        }
        results.push(snapshot);
      }
      assert.deepEqual(results[1],results[0],kind);
      assert.deepEqual(results[0],{reports:kind==='remove'?[]:[...(javascript?[{earlier:true}]:[]),{replacement:finalURL}],src:kind==='src'?origin+'/replacement':kind==='javascript-src'?nextProgram:null,url:kind==='remove'?null:finalURL},kind);
    }
    assert.deepEqual(direct,[],'Queued navigation bypassed the relay');
    assert.deepEqual(errors,[],'Queued navigation raised a script error');
  }finally{
    held?.release();
    await fixture.evaluate(()=>{const state=globalThis.queuedNavigation;if(state){state.release();state.target.onmessage=state.receive;}}).catch(()=>{});
    await fixture.close();await nativeContext.close();
  }
  return ['Document navigations and frame removal cancel queued JavaScript URLs without waiting for abandoned readiness','JavaScript-only navigations retain queued programs and preserve native src attribute behavior'];
}
