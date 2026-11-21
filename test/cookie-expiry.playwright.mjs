import assert from 'node:assert/strict';

const origin='https://cookie-expiry-native.test';
const cookies={
  '/arm-read':'read=1; Max-Age=2; Path=/',
  '/arm-hidden':'hidden=1; HttpOnly; Max-Age=2; Path=/',
  '/arm-steady':'steady=1; Path=/',
  '/arm-replace':'replace=old; HttpOnly; Max-Age=2; Path=/write-only'
};
const arm='(async()=>{await Promise.all(["/arm-read","/arm-hidden","/arm-steady","/arm-replace"].map(url=>fetch(url)));document.cookie="script=1; Max-Age=2; Path=/";return true;})()';
const sample='(async()=>({doc:document.cookie.split("; ").filter(Boolean).sort(),headers:await(await fetch("/echo")).json()}))()';

export async function verifyCookieExpiry(page){
  const native=await page.context().newPage(),html='<!doctype html><body>Cookie expiry';
  await native.route(origin+'/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(cookies[path])return route.fulfill({status:204,headers:{'set-cookie':cookies[path],'cache-control':'no-store'}});
    if(path.endsWith('/echo'))return route.fulfill({contentType:'application/json',headers:{'cache-control':'no-store'},body:JSON.stringify((route.request().headers().cookie||'').split('; ').filter(Boolean).sort())});
    return route.fulfill({contentType:'text/html',body:html});
  });
  try{
    await page.evaluate(({origin,cookies,html})=>{
      globalThis.cookieExpiryPrevious=sandstone.network.session.fetch;
      sandstone.network.session.fetch=async(url,options)=>{
        if(new URL(url).origin!==origin)return cookieExpiryPrevious(url,options);
        const path=new URL(url).pathname;
        if(cookies[path]){
          const response=new Response(null,{status:204,headers:{'cache-control':'no-store'}});
          Object.defineProperty(response,'raw_headers',{value:[['set-cookie',cookies[path]]]});return response;
        }
        if(path.endsWith('/echo'))return new Response(JSON.stringify((options.headers.cookie||'').split('; ').filter(Boolean).sort()),{headers:{'content-type':'application/json','cache-control':'no-store'}});
        return new Response(html,{headers:{'content-type':'text/html'}});
      };
    },{origin,cookies,html});
    await native.goto(origin+'/start');await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');
    await Promise.all([native.evaluate(source=>eval(source),arm),page.evaluate(source=>main_frame.eval_js(source),arm)]);
    const started=Date.now();let checkedActive=false;
    while(Date.now()-started<2800){
      const elapsed=Date.now()-started;
      const [expected,actual]=await Promise.all([native.evaluate(source=>eval(source),sample),page.evaluate(source=>main_frame.eval_js(source),sample)]);
      // Allow different IPC/HTTP acceptance times at the expiry boundary.
      if(elapsed<1000){assert.deepEqual(actual,expected);assert.ok(actual.headers.includes('hidden=1'));assert.ok(!actual.doc.includes('hidden=1'));checkedActive=true;}
      await page.waitForTimeout(150);
    }
    assert.equal(checkedActive,true);
    const expired=await page.evaluate(source=>main_frame.eval_js(source),sample);
    assert.deepEqual(expired,await native.evaluate(source=>eval(source),sample));
    assert.deepEqual(expired,{doc:['steady=1'],headers:['steady=1']});
    const replace='(async()=>{document.cookie="replace=new; Max-Age=120; Path=/write-only";return await(await fetch("/write-only/echo")).json();})()';
    const expectedReplacement=await native.evaluate(source=>eval(source),replace);assert.deepEqual(expectedReplacement,['replace=new','steady=1']);
    assert.deepEqual(await page.evaluate(source=>main_frame.eval_js(source),replace),expectedReplacement);
    return ['Reading document and request cookies does not renew Max-Age','HttpOnly cookies expire without becoming script-readable','Expired HttpOnly cookies permit a fresh script cookie at their old path'];
  }finally{await page.evaluate(origin=>{sandstone.controller.site_data.clear(new URL(origin).hostname,{cookies:true,localStorage:false});if(globalThis.cookieExpiryPrevious){sandstone.network.session.fetch=cookieExpiryPrevious;delete globalThis.cookieExpiryPrevious;}},origin);await native.close();await page.bringToFront();}
}
