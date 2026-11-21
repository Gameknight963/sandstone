import assert from 'node:assert/strict';

export async function verifyAncestorWindowOpen(page){
  const native=await page.context().newPage(),fixture=await page.context().newPage(),requests=[],direct=[],errors=[];
  const origin='https://ancestor-open.test';
  const html=url=>{
    const path=new URL(url).pathname;
    const cross=new URL(url).searchParams.has('cross');
    if(path==='/start')return '<!doctype html><head><base href="/root-base/"></head><body><script>addEventListener("message",event=>{if(event.data?.leafReady)globalThis.leaf=event.source;if(event.data?.probe)globalThis.openProbe=event.data.probe;});</script><iframe name="MiddleNamed" src="/middle'+(cross?'?cross=1':'')+'"></iframe>';
    if(path==='/middle')return '<!doctype html><head><base href="/middle-base/"></head><body><iframe src="'+(cross?'https://ancestor-open-other.test':'')+'/leaf"></iframe>';
    if(path==='/leaf')return `<!doctype html><head><base href="/leaf-base/"></head><body><script>
      addEventListener('message',event=>{
        const value=event.data;
        if(value?.probe){
          const attempt=callback=>{try{return callback();}catch(error){return error.name;}};
          const probe={parent:attempt(()=>parent.open('','_self')===parent),top:attempt(()=>top.open('','_self')===top),borrowed:attempt(()=>open.call(parent,'','_self')===parent),override:attempt(()=>{
            const original=parent.open,replacement=function(){return this===parent;};parent.open=replacement;
            const identity=parent.open===replacement,receiver=parent.open();parent.open=original;
            return {identity,receiver,restored:parent.open===original};
          })};
          top.postMessage({probe},'*');return;
        }
        if(!value?.openAncestor)return;
        const receiver=value.receiver==='top'?top:parent;
        if(value.borrowed)open.call(receiver,'landing',value.target,value.features||'');
        else receiver.open('landing',value.target,value.features||'');
      });
      top.postMessage({leafReady:true},'*');
    </script>`;
    return '<!doctype html><body>Landing<script>globalThis.landed=true;</script>';
  };
  fixture.on('pageerror',error=>errors.push(error.message));
  try{
    await native.route(/^https:\/\/ancestor-open(?:-other)?\.test\//,async route=>{
      const request=route.request();if(new URL(request.url()).pathname.endsWith('/landing'))requests.push({url:request.url(),referrer:(await request.allHeaders()).referer||''});
      await route.fulfill({contentType:'text/html',headers:{'cache-control':'no-store'},body:html(request.url())});
    });
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.evaluate(body=>{
      const html=(0,eval)('('+body+')');globalThis.ancestorOpenRequests=[];main_frame.on_load=()=>{};
      sandstone.network.session.fetch=async(url,options)=>{
        if(new URL(url).pathname.endsWith('/landing'))ancestorOpenRequests.push({url,referrer:new Headers(options.headers).get('referer')||''});
        return new Response(html(url),{headers:{'content-type':'text/html','cache-control':'no-store'}});
      };
    },html.toString());
    const read=(proxy,source)=>proxy?fixture.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
    const wait=async(proxy,source)=>{
      const end=Date.now()+7000;while(!await read(proxy,source)){if(Date.now()>end)throw new Error('Ancestor window.open readiness timed out');await fixture.waitForTimeout(20);}
    };
    const arrived=async proxy=>{
      const end=Date.now()+7000;
      while(Date.now()<end){
        for(const frame of (proxy?fixture:native).frames())try{
          const value=await frame.evaluate(proxy=>proxy?globalThis.sandstone_frame?.context.run_script('JSON.stringify({url:location.href,referrer:document.referrer,landed:globalThis.landed===true})'):JSON.stringify({url:location.href,referrer:document.referrer,landed:globalThis.landed===true}),proxy);
          if(value){const result=JSON.parse(value);if(result.landed)return result;}
        }catch{}
        await fixture.waitForTimeout(20);
      }
      throw new Error('Ancestor window.open destination did not load');
    };
    for(const cross of [false,true]){
      const results=[];
      for(const proxy of [false,true]){
        const url=origin+'/start'+(cross?'?cross=1':'');
        if(proxy)await fixture.evaluate(url=>main_frame.navigate_to(url),url);else await native.goto(url);
        await wait(proxy,'!!globalThis.leaf');await read(proxy,'leaf.postMessage({probe:true},"*")');await wait(proxy,'!!globalThis.openProbe');
        results.push(JSON.parse(await read(proxy,'JSON.stringify(openProbe)')));
      }
      assert.deepEqual(results[1],results[0],'Ancestor Window.open identity, overrides and cross-origin validation '+cross);
    }
    for(const [receiver,target,borrowed,features] of [['parent','_self',false,''],['parent','_parent',false,''],['top','_self',false,''],['top','_parent',false,''],['parent','_self',true,''],['top','MiddleNamed',false,''],['parent','_self',false,'noreferrer']]){
      const results=[];
      for(const proxy of [false,true]){
        console.log(JSON.stringify({fixture:'Ancestor window.open',receiver,target,borrowed,features,proxy}));
        if(proxy)await fixture.evaluate(url=>main_frame.navigate_to(url),origin+'/start');else await native.goto(origin+'/start');
        await wait(proxy,'!!globalThis.leaf');
        if(proxy)await fixture.evaluate(()=>{ancestorOpenRequests=[];});else requests.length=0;
        await read(proxy,'leaf.postMessage('+JSON.stringify({openAncestor:true,receiver,target,borrowed,features})+',"*")');
        const document=await arrived(proxy).catch(error=>{throw new Error(error.message+' '+JSON.stringify({receiver,target,borrowed,features,proxy,errors}),{cause:error});}),request=proxy?await fixture.evaluate(()=>ancestorOpenRequests.at(-1)):requests.at(-1);
        results.push({document,request});
      }
      assert.equal(results[0].request.url,origin+'/leaf-base/landing');
      assert.deepEqual(results[1],results[0],JSON.stringify({receiver,target,borrowed,features})+' retains the child caller context');
    }
    assert.deepEqual(direct,[],'Ancestor window.open bypassed the relay');
    assert.deepEqual(errors,[],'Ancestor window.open raised script errors');
  }finally{await native.close();await fixture.close();}
  return ['Ancestor Window.open receivers and borrowed methods retain the initiating descendant URL, referrer and noreferrer policy','Ancestor Window.open identity, overrides and cross-origin access match native behavior'];
}
