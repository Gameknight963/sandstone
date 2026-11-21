import assert from 'node:assert/strict';

export async function verifyWindowOpen(page){
  const native=await page.context().newPage(),fixture=await page.context().newPage(),direct=[],errors=[],requests=[];
  const origin='https://open.test';
  const html=url=>new URL(url).pathname==='/start'?'<html><head><base href="/base/"></head><body><iframe id="destination" name="destination" src="/child"></iframe><script>globalThis.openRoot=true;globalThis.ready=true;</script></body></html>':'<!doctype html><head><base href="/child-base/"></head><body>Destination<script>addEventListener("message",event=>{if(event.data==="open-self")open("landing","_self");});globalThis.ready=true;</script>';
  fixture.on('pageerror',error=>errors.push(error.message));
  try{
    await native.route(origin+'/**',async route=>{const request=route.request(),headers=await request.allHeaders();if(new URL(request.url()).pathname.endsWith('/landing'))requests.push({url:request.url(),referrer:headers.referer||''});await route.fulfill({contentType:'text/html; charset='+(new URL(request.url()).searchParams.get('charset')||'UTF-8'),headers:{'cache-control':'no-store'},body:html(request.url())});});
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.evaluate(body=>{
      const html=(0,eval)('('+body+')');globalThis.openRequests=[];main_frame.on_load=()=>{};
      sandstone.network.session.fetch=async(url,options)=>{const headers=new Headers(options.headers);if(new URL(url).pathname.endsWith('/landing'))openRequests.push({url,referrer:headers.get('referer')||''});return new Response(html(url),{headers:{'content-type':'text/html; charset='+(new URL(url).searchParams.get('charset')||'UTF-8'),'cache-control':'no-store'}});};
    },html.toString());
    const read=(proxy,source)=>proxy?fixture.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
    const start=async(proxy,charset='UTF-8')=>{const url=origin+'/start?charset='+charset;if(proxy)await fixture.evaluate(url=>main_frame.navigate_to(url),url);else await native.goto(url);if(proxy)await fixture.evaluate(()=>{openRequests=[];});else requests.length=0;};
    const arrived=async(proxy,url)=>{
      const surface=proxy?fixture:native,expires=Date.now()+7000;
      while(Date.now()<expires){
        for(const frame of surface.frames())try{
          const result=await frame.evaluate(proxy=>proxy?globalThis.sandstone_frame?.context.run_script('JSON.stringify({url:location.href,referrer:document.referrer,ready:globalThis.ready===true})'):JSON.stringify({url:location.href,referrer:document.referrer,ready:globalThis.ready===true}),proxy);
          if(result){const value=JSON.parse(result);if(value.ready&&value.url===url)return value;}
        }catch{}
        await surface.waitForTimeout(20);
      }
      throw new Error('Window.open destination did not load: '+url);
    };
    for(const [target,features,charset] of [['_self','','UTF-8'],['_PARENT','','UTF-8'],['_top','','UTF-8'],['RootNamed','','UTF-8'],['destination','','UTF-8'],['_self','noreferrer','UTF-8'],['_self','noopener','UTF-8'],['_self','','windows-1252']]){
      const results=[];
      for(const proxy of [false,true]){
        await start(proxy,charset);
        const result=JSON.parse(await read(proxy,'JSON.stringify((()=>{window.name="RootNamed";const child=document.getElementById("destination").contentWindow;const result=window.open("landing?q=caf\\u00e9",'+JSON.stringify(target)+','+JSON.stringify(features)+');return {self:result===window,child:result===child};})())'));
        const url=origin+'/base/landing?q=caf'+(charset==='UTF-8'?'%C3%A9':'%E9');
        const document=await arrived(proxy,url),request=proxy?await fixture.evaluate(()=>openRequests.at(-1)):requests.at(-1);
        results.push({result,document,request});
      }
      assert.deepEqual(results[1],results[0],target+' '+features+' '+charset+' window.open navigation and identity');
    }
    for(const method of ['child.open("landing","_self")','open.call(child,"landing","_self")','child.open("landing","_parent")','child.open("landing","_top")']){
      const results=[];
      for(const proxy of [false,true]){
        await start(proxy);
        await arrived(proxy,origin+'/child');
        const identity=JSON.parse(await read(proxy,`JSON.stringify((()=>{const child=document.getElementById('destination').contentWindow;const result=${method};return {self:result===window,child:result===child};})())`));
        const document=await arrived(proxy,origin+'/base/landing'),request=proxy?await fixture.evaluate(()=>openRequests.at(-1)):requests.at(-1);
        results.push({identity,document,request});
      }
      assert.deepEqual(results[1],results[0],method+' uses the caller document base and referrer');
    }
    for(const proxy of [false,true]){
      await start(proxy);
      await arrived(proxy,origin+'/child');
      const override=JSON.parse(await read(proxy,`JSON.stringify((()=>{
        const child=document.getElementById('destination').contentWindow,original=child.open;
        const replacement=function(value){return {receiver:this===child,value};};
        child.open=replacement;const identity=child.open===replacement,result=child.open('custom');
        child.open=original;return {identity,result,restored:child.open===original};
      })())`));
      assert.deepEqual(override,{identity:true,result:{receiver:true,value:'custom'},restored:true},'Authored Window.open overrides and restoration retain identity');
      const validation=JSON.parse(await read(proxy,`JSON.stringify((()=>{
        const order=[],convert=name=>({toString(){order.push(name);return name==='url'?'':name==='target'?'_self':'';}});
        const result=window.open(convert('url'),convert('target'),convert('features'));
        const error=operation=>{try{operation();return null;}catch(error){return error.name;}};
        return {order,self:result===window,named:open('','destination')===document.getElementById('destination').contentWindow,
          invalid:error(()=>open('http://[','_blank')),symbol:error(()=>open(Symbol('url'),'_self')),receiver:error(()=>open.call({},'','_self')),name:open.name,length:open.length};
      })())`));
      assert.deepEqual(validation,{order:['url','target','features'],self:true,named:true,invalid:'SyntaxError',symbol:'TypeError',receiver:'TypeError',name:'open',length:0},'window.open synchronous validation');
    }
    const restored=[];
    for(const proxy of [false,true]){
      await start(proxy);await arrived(proxy,origin+'/child');
      await read(proxy,`(()=>{const child=document.getElementById('destination').contentWindow,original=child.open;child.open=()=>null;child.open=original;child.postMessage('open-self','*');})()`);
      const document=await arrived(proxy,origin+'/child-base/landing'),request=proxy?await fixture.evaluate(()=>openRequests.at(-1)):requests.at(-1);
      restored.push({document,request});
    }
    assert.deepEqual(restored[1],restored[0],'Restored child open uses its own caller context');
    await start(true);
    assert.equal(await read(true,'open("https://open.test/not-loaded","_blank")===null'),true,'Blocked auxiliary window result');
    assert.equal(await read(true,'open("https://open.test/not-loaded","destination","noopener")===null'),true,'noopener names require an auxiliary context');
    assert.deepEqual(await fixture.evaluate(()=>openRequests),[],'Blocked windows must not navigate an existing context');
    assert.deepEqual(direct,[],'window.open bypassed the relay');assert.deepEqual(errors,[],'window.open raised script errors');
  }finally{await native.close();await fixture.close();}
  return ['Window.open self/parent/top and named frames navigate through the relay with native Window identity','Foreign Window.open receivers retain the caller document base and referrer','Window.open preserves noreferrer, document URL encoding and synchronous argument validation'];
}
