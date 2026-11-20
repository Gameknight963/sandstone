import assert from 'node:assert/strict';

export async function verifyPendingCookieClear(page){
  const fixture=await page.context().newPage(),errors=[],direct=[],origin='https://pending-cookie-clear.test';fixture.on('pageerror',error=>errors.push(error.message));
  const read=source=>fixture.evaluate(source=>main_frame.eval_js('(async()=>JSON.stringify(await ('+source+')))()'),source).then(JSON.parse);
  try{
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
    await fixture.evaluate(origin=>{
      main_frame.on_load=()=>{};
      sandstone.controller.site_data.setCookie(origin,'old=before; Path=/; Max-Age=3600');
      sandstone.network.session.fetch=async url=>{
        const path=new URL(url).pathname,headers={'cache-control':'no-store','content-type':'text/html'};
        if(path==='/held')return new Promise(resolve=>{globalThis.releaseCookieResponse=()=>{const response=new Response('held',{headers});Object.defineProperty(response,'raw_headers',{value:[...response.headers,['set-cookie','stale=restored; HttpOnly; Path=/; Max-Age=3600'],['set-cookie','fresh=deleted; Path=/; Max-Age=0']]});resolve(response);};});
        if(path==='/fresh'){const response=new Response('fresh',{headers});Object.defineProperty(response,'raw_headers',{value:[...response.headers,['set-cookie','received=after; HttpOnly; Path=/; Max-Age=3600']]});return response;}
        return new Response('<!doctype html><body>Pending cookie response',{headers});
      };
    },origin);
    await fixture.evaluate(url=>main_frame.navigate_to(url),origin+'/page');
    await read('(async()=>{void fetch("/held",{keepalive:true}).catch(()=>{});return true;})()');
    await fixture.waitForFunction(()=>!!globalThis.releaseCookieResponse&&sandstone.network.keepalives.requests.size>0);
    await fixture.evaluate(()=>globalThis.cookieTransfer=[...sandstone.network.keepalives.requests.values()][0].completion);
    const previous=await fixture.evaluate(()=>main_frame.document_context);
    await fixture.getByRole('button',{name:'Options',exact:true}).click();await fixture.locator('#site_data_details').evaluate(element=>element.open=true);
    await fixture.locator('.site_data_row').filter({hasText:/^pending-cookie-clear\.test:/}).getByRole('button',{name:'Clear cookies',exact:true}).click();
    await fixture.waitForFunction(previous=>main_frame.document_context!==previous&&!main_frame.is_navigating,previous);
    await read('(async()=>{document.cookie="fresh=after; Path=/; Max-Age=3600";return true;})()');
    await fixture.waitForFunction(origin=>sandstone.controller.site_data.cookies.getCookieStringSync(origin)==='fresh=after',origin);
    await fixture.evaluate(async()=>{releaseCookieResponse();await cookieTransfer;});
    assert.equal(await fixture.evaluate(origin=>sandstone.controller.site_data.cookies.getCookieStringSync(origin),origin),'fresh=after');
    assert.equal(await read('document.cookie'),'fresh=after');
    assert.equal(await read('(async()=>await(await fetch("/fresh")).text())()'),'fresh');
    assert.equal(await fixture.evaluate(origin=>sandstone.controller.site_data.cookies.getCookieStringSync(origin),origin),'fresh=after; received=after');
    assert.equal(await fixture.evaluate(()=>[...sandstone.network.keepalives.requests.values()].length),0);
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Clear cookies prevents pending keepalive responses from restoring HttpOnly cookies or deleting fresh values','Requests made after clearing still accept new response cookies and release keepalive reservations'];
  }finally{await fixture.close();await page.bringToFront();}
}
