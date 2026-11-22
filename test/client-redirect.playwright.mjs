import assert from 'node:assert/strict';
import {wait_for} from './wait-for.mjs';

// Exercise a real client-side redirect, including its noscript fallback. There
// is no URL rewriting or special treatment of a search engine in this fixture.
export async function verifyClientRedirects(page){
  const browser=page.context().browser(),fixture=await page.context().newPage();
  const source='https://redirect-source.test/results',hop='https://redirect-hop.test/redirect',destination='https://redirect-final.test/done';
  const body=url=>url===source?'<a href="'+hop+'">Open result</a>':url===hop?
    `<head><meta name="referrer" content="origin"></head><body><script language="JavaScript">document.cookie="redirect=ran; Path=/";window.parent.location.replace("${destination}");</script><noscript><meta http-equiv="refresh" content="0;URL=${destination}"></noscript>`:
    '<title>Destination</title><h1>Arrived</h1>';
  const errors=[],direct=[],onError=error=>errors.push(error.message),onRequest=request=>{if(/^https?:/.test(request.url()))direct.push(request.url());};
  fixture.on('pageerror',onError);fixture.on('request',onRequest);
  try{
    await fixture.goto(page.url());
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.evaluate(({source,hop,destination,documents})=>{
      globalThis.redirectRequests=[];
      sandstone.network.session.fetch=async url=>{
        if(![source,hop,destination].includes(String(url)))return new Response(null,{status:204});
        redirectRequests.push(String(url));
        return new Response(documents[String(url)],{headers:{'content-type':'text/html;charset=UTF-8'}});
      };
    },{source,hop,destination,documents:Object.fromEntries([source,hop,destination].map(url=>[url,'<!doctype html>'+body(url)]))});
    for(const scripting of [true,false]){
      const nativeContext=await browser.newContext({javaScriptEnabled:scripting}),native=await nativeContext.newPage();
      try{
        await nativeContext.route(/^https:\/\/redirect-(source|hop|final)\.test\//,route=>{
          const url=route.request().url();
          return [source,hop,destination].includes(url)?route.fulfill({contentType:'text/html',body:'<!doctype html>'+body(url)}):route.fulfill({status:204});
        });
        await native.goto(source);
        await native.getByRole('link',{name:'Open result',exact:true}).click();
        await native.waitForURL(destination);
        await fixture.evaluate(async({source,scripting})=>{main_frame.default_settings.allow_js=scripting;redirectRequests=[];await main_frame.navigate_to(source);},{source,scripting});
        await fixture.frameLocator('iframe[frame-id]').getByRole('link',{name:'Open result',exact:true}).click();
        await wait_for(()=>fixture.evaluate(destination=>String(main_frame.url)===destination&&!main_frame.is_navigating,destination),{timeout:10000});
        assert.equal(await fixture.evaluate(()=>main_frame.eval_js('document.querySelector("h1").textContent')),await native.locator('h1').textContent());
        assert.deepEqual(await fixture.evaluate(()=>redirectRequests),[source,hop,destination]);
        if(scripting){
          // Reading cookies from the original redirect origin also exercises
          // the active-document check which guards script navigation.
          const value=await fixture.evaluate(()=>sandstone.controller.site_data.documentCookies('https://redirect-hop.test/redirect'));
          assert.ok(value.cookies.some(cookie=>cookie.key==='redirect'&&cookie.value==='ran'),'The redirect script did not write its cookie');
        }
      }finally{await nativeContext.close();}
    }
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Client-side parent.location.replace and noscript redirects follow the normal navigation path'];
  }finally{await fixture.close();}
}
