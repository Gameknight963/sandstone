import assert from 'node:assert/strict';

export async function verify_cookie_policy_handoff(browser,origin){
  const context=await browser.newContext();
  try{
    const first=await context.newPage(),second=await context.newPage();
    await first.goto(origin+'/host-worker/page');await first.addScriptTag({url:origin+'/host-worker/bundle.js'});
    const writes=await first.evaluate(async()=>{
      const store=sandstone.controller.site_data,handle=sandstone.cookie_policy_handler(store),url='https://cookie-handoff.test/directory/script.js';
      await store.ready;
      // Simulate closing between the atomic storage record and the private
      // payload broadcast. A replacement must recover only this exact write.
      store.cookieSession?.close();
      const options=await handle({op:'capture',context:{}}),result=[];
      for(const [value,apply] of [['session=secret; HttpOnly; Path=/',true],['durable=first; Max-Age=3600; Path=/',true],['pending=accepted; Max-Age=3600; Path=/',false]]){
        const cookieWrite=await handle({op:'prepare',url,value,options});
        if(result.length===1)cookieWrite.time=result[0].options.cookieWrite.time;
        const message={op:'set',url,value,options:{...options,cookieWrite}};
        if(apply)await handle(message);result.push(message);
      }
      return result;
    });
    await first.close();
    await second.goto(origin+'/host-worker/page');await second.addScriptTag({url:origin+'/host-worker/bundle.js'});
    const result=await second.evaluate(async writes=>{
      const store=sandstone.controller.site_data,handle=sandstone.cookie_policy_handler(store),url=writes[0].url;
      await store.ready;store.refresh();
      const read=key=>store.cookies.serializeSync().cookies.find(cookie=>cookie.key===key);
      const missingSession=!read('session');
      store.clear('unrelated-handoff.test',{cookies:true,localStorage:false});
      await handle(writes[0]);await handle(writes[2]);
      const restored=read('session'),pending=read('pending');
      const restoredHeader=store.cookies.getCookieStringSync(url);
      store.setCookie(url,'durable=newer; Max-Age=3600; Path=/',true);
      const version=store.persistence.cookieVersion(read('durable')).version;
      await handle(writes[1]);
      const newer=read('durable').value,versionUnchanged=store.persistence.cookieVersion(read('durable')).version===version;
      const hidden=!store.documentCookies(url).cookies.some(cookie=>cookie.key==='session');
      store.clear('cookie-handoff.test',{cookies:true,localStorage:false});
      store.setCookie(url,'session=fresh; HttpOnly; Path=/',true);await handle(writes[0]);
      return {missingSession,restored:restored?.value,time:restored?.lastAccessed,pending:pending?.value,restoredHeader,newer,versionUnchanged,hidden,afterClear:read('session')?.value};
    },writes);
    assert.deepEqual(result,{missingSession:true,restored:'secret',time:writes[0].options.cookieWrite.cookie.lastAccessed,pending:'accepted',restoredHeader:'session=secret; durable=first; pending=accepted',newer:'newer',versionUnchanged:true,hidden:true,afterClear:'fresh'});
    return ['Cookie provider handoff applies an uncommitted write and preserves newer cookies when retrying an uncertain commit','Private session payload recovery preserves its timestamp and HttpOnly isolation','Clear epochs remain authoritative across cookie provider windows'];
  }finally{await context.close();}
}
