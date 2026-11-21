import assert from 'node:assert/strict';
import {wait_for} from './wait-for.mjs';

const origin='https://iframe-load-lifetime.test';
const child='<!doctype html><body><div id="anchor">Anchor</div><script>parent.childRan=true</script>';
const html=lazy=>'<!doctype html><body><script>globalThis.frameEvents=[];document.addEventListener("DOMContentLoaded",()=>frameEvents.push("dom"));addEventListener("load",()=>frameEvents.push("load"));</script><iframe id="nested" '+(lazy?'loading="lazy" ':'')+'src="/held-child#anchor" onload="frameEvents.push(\'frame\')"></iframe>';
const snapshot='({events:frameEvents,ready:document.readyState,childRan:!!globalThis.childRan})';

async function without_scripts(page){
  const context=await page.context().browser().newContext({javaScriptEnabled:false}),native=await context.newPage();
  const parent='<!doctype html><body><iframe id="nested" loading="lazy" src="/held-child"></iframe>',child='<!doctype html><body><b id="loaded">Loaded</b>';
  let release,entered,navigation;
  const requested=new Promise(resolve=>entered=resolve);
  await native.route(origin+'/**',async route=>{
    if(new URL(route.request().url()).pathname==='/held-child'){entered();await new Promise(resolve=>release=resolve);return route.fulfill({contentType:'text/html',body:child}).catch(()=>{});}
    return route.fulfill({contentType:'text/html',body:parent});
  });
  try{
    await native.goto(origin+'/no-script-lazy',{waitUntil:'domcontentloaded'});await requested;
    const expected=await native.evaluate(()=>document.readyState);assert.equal(expected,'interactive');
    await page.evaluate(({origin,parent,child})=>{
      globalThis.iframeLoadLifetime={fetch:sandstone.network.session.fetch,allow:main_frame.default_settings.allow_js};main_frame.default_settings.allow_js=false;
      sandstone.network.session.fetch=async(url,options)=>{
        if(new URL(url).origin!==origin)return iframeLoadLifetime.fetch(url,options);
        if(new URL(url).pathname==='/held-child'){iframeLoadLifetime.requested=true;await new Promise(resolve=>iframeLoadLifetime.release=resolve);return new Response(child,{headers:{'content-type':'text/html'}});}
        return new Response(parent,{headers:{'content-type':'text/html'}});
      };
    },{origin,parent,child});
    navigation=page.evaluate(url=>main_frame.navigate_to(url),origin+'/no-script-lazy');
    await page.waitForFunction(()=>iframeLoadLifetime.requested);
    await wait_for(async()=>await page.evaluate(()=>main_frame.eval_js('document.readyState'))!=='loading');
    assert.equal(await page.evaluate(()=>main_frame.eval_js('document.readyState')),expected,'Disabled scripting must keep lazy frames load-blocking');
    release();await native.waitForLoadState('load');await page.evaluate(()=>iframeLoadLifetime.release());await navigation;
    assert.equal(await page.evaluate(()=>main_frame.eval_js('document.readyState')),'complete');
  }finally{
    release?.();await page.evaluate(()=>{if(globalThis.iframeLoadLifetime){iframeLoadLifetime.release?.();main_frame.default_settings.allow_js=iframeLoadLifetime.allow;sandstone.network.session.fetch=iframeLoadLifetime.fetch;delete globalThis.iframeLoadLifetime;}});
    await navigation?.catch(()=>{});await context.close();
  }
}

export async function verifyIframeLoadLifetime(page){
  const context=page.context(),native=await context.newPage(),results=[];
  const read=async proxy=>JSON.parse(proxy?await page.evaluate(source=>main_frame.eval_js('JSON.stringify('+source+')'),snapshot):await native.evaluate(source=>JSON.stringify(eval(source)),snapshot));
  let release,requested,proxyNavigation;
  const route=async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/held-child'){requested();await new Promise(resolve=>release=resolve);return route.fulfill({contentType:'text/html',body:child}).catch(()=>{});}
    return route.fulfill({contentType:'text/html',body:path==='/replacement'?child:html(path==='/lazy')});
  };
  await native.route(origin+'/**',route);
  try{
    for(const mode of ['held','removed','superseded','lazy']){
      let entered;const started=new Promise(resolve=>entered=resolve);requested=entered;
      const navigation=native.goto(origin+'/'+mode,{waitUntil:'domcontentloaded'});
      await started;await navigation;
      if(mode==='lazy')await native.waitForFunction(()=>frameEvents.includes('load'));
      const expectedBefore=await read(false);
      if(mode==='removed')await native.evaluate(()=>document.getElementById('nested').remove());
      if(mode==='superseded')await native.evaluate(()=>document.getElementById('nested').src='/replacement');
      if(mode!=='held')await native.waitForFunction(()=>frameEvents.includes('load'));
      release();await native.waitForLoadState('load');
      if(mode!=='removed')await native.waitForFunction(()=>frameEvents.includes('frame'));
      const expectedAfter=await read(false);

      await page.evaluate(({origin,html,child})=>{
        globalThis.iframeLoadLifetime={fetch:sandstone.network.session.fetch};
        sandstone.network.session.fetch=async(url,options)=>{
          if(new URL(url).origin!==origin)return iframeLoadLifetime.fetch(url,options);
          const path=new URL(url).pathname;
          if(path==='/held-child'){
            iframeLoadLifetime.requested=true;await new Promise(resolve=>iframeLoadLifetime.release=resolve);
            return new Response(child,{headers:{'content-type':'text/html'}});
          }
          return new Response(path==='/replacement'?child:html,{headers:{'content-type':'text/html'}});
        };
      },{origin,html:html(mode==='lazy'),child});
      proxyNavigation=page.evaluate(url=>main_frame.navigate_to(url),origin+'/'+mode);
      await page.waitForFunction(()=>iframeLoadLifetime.requested);
      await wait_for(async()=>{const events=JSON.parse(await page.evaluate(()=>main_frame.eval_js('JSON.stringify(globalThis.frameEvents||[])')));return Array.isArray(events)&&events.includes('dom');});
      if(mode==='lazy')await wait_for(async()=>{const events=JSON.parse(await page.evaluate(()=>main_frame.eval_js('JSON.stringify(globalThis.frameEvents||[])')));return Array.isArray(events)&&events.includes('load');});
      assert.deepEqual(await read(true),expectedBefore,'Parent load before child response: '+mode);
      if(mode==='removed')await page.evaluate(()=>main_frame.eval_js('document.getElementById("nested").remove();true'));
      if(mode==='superseded')await page.evaluate(()=>main_frame.eval_js('document.getElementById("nested").src="/replacement";true'));
      if(mode!=='held')await proxyNavigation;
      await page.evaluate(()=>iframeLoadLifetime.release());await proxyNavigation;
      if(mode!=='removed')await wait_for(async()=>{const events=JSON.parse(await page.evaluate(()=>main_frame.eval_js('JSON.stringify(globalThis.frameEvents||[])')));return Array.isArray(events)&&events.includes('frame');});
      assert.deepEqual(await read(true),expectedAfter,'Parent load after child response: '+mode);
      await page.evaluate(()=>{sandstone.network.session.fetch=iframeLoadLifetime.fetch;delete globalThis.iframeLoadLifetime;});
      results.push('Native iframe load lifetime: '+mode);
    }
    await without_scripts(page);results.push('Lazy iframe loading remains blocking when author JavaScript is disabled');
    return results;
  }finally{
    release?.();await page.evaluate(()=>{if(globalThis.iframeLoadLifetime){iframeLoadLifetime.release?.();sandstone.network.session.fetch=iframeLoadLifetime.fetch;delete globalThis.iframeLoadLifetime;}});
    await proxyNavigation?.catch(()=>{});
    await native.close();await page.bringToFront();
  }
}
