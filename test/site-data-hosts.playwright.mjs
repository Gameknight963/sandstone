import assert from 'node:assert/strict';
import {CookieJar} from 'tough-cookie';

export async function verifyHostSiteData(browser,target){
  const context=await browser.newContext(),errors=[];
  context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  const origin='https://host-state.test';
  const legacyOrigin='https://legacy-host-state.test',jar=new CookieJar();
  jar.setCookieSync('legacy=old; Max-Age=86400; Path=/',legacyOrigin+'/');
  const legacy=JSON.stringify({local:{[legacyOrigin]:[['saved','legacy']]},cookies:jar.serializeSync(),indexed:[]});
  await context.addInitScript(legacy=>{
    if(window!==top)return;
    try{if(!localStorage.getItem('sandstone_site_data_v2:["migrated"]'))localStorage.setItem('sandstone_site_data_v1',legacy);}catch{}
  },legacy);
  const read=async(page,expression)=>JSON.parse(await page.evaluate(source=>main_frame.eval_js('JSON.stringify('+source+')'),expression));
  const write=(page,source)=>page.evaluate(source=>main_frame.eval_js(source+';true'),source);
  async function wait(page,expression){
    const deadline=Date.now()+5000;
    while(!await read(page,expression)){
      assert.ok(Date.now()<deadline,'Host state did not synchronize: '+expression);
      await page.waitForTimeout(20);
    }
  }
  async function open(page,path){
    if(!page.url().startsWith(target))await page.goto(target);
    await page.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await page.evaluate(async url=>{
      main_frame.on_load=()=>{};
      main_frame.special_pages[url]='<!doctype html><body>Shared host data<script>globalThis.storageEvents=[];addEventListener("storage",event=>storageEvents.push({key:event.key,oldValue:event.oldValue,newValue:event.newValue,url:event.url,area:event.storageArea===localStorage}));<\/script>';
      await main_frame.navigate_to(url);
    },origin+path);
  }
  try{
    const native=await context.newPage();
    await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><body>Native storage event'}));
    await native.goto(origin+'/native');
    const childURL=await native.evaluate(()=>new Promise(resolve=>{
      addEventListener('storage',event=>{if(event.key==='child')resolve(event.url);},{once:true});
      const frame=document.createElement('iframe');frame.srcdoc='<script>localStorage.setItem("child","srcdoc")<\/script>';document.body.append(frame);
    }));
    assert.equal(childURL,'about:srcdoc');await native.close();
    const first=await context.newPage(),second=await context.newPage();
    await open(first,'/first');await open(second,'/second');
    assert.deepEqual(await first.evaluate(origin=>{
      const store=sandstone.controller.site_data;
      return {cookie:store.cookies.getCookieStringSync(origin+'/'),local:store.local[origin]};
    },legacyOrigin),{cookie:'legacy=old',local:[['saved','legacy']]});
    await first.evaluate(({origin,legacy})=>{
      sandstone.controller.site_data.clear(origin.replace('https://',''));
      // An older host may still save its old snapshot after migration.
      localStorage.setItem('sandstone_site_data_v1',legacy);
    },{origin:legacyOrigin,legacy});
    await write(first,'document.cookie="login=one; Max-Age=86400; Path=/";document.cookie="temporary=session; Path=/";localStorage.setItem("saved","one")');
    await first.evaluate(()=>sandstone.controller.site_data.setCookie('https://host-state.test/','secret=hidden; HttpOnly; Path=/'));
    await wait(second,'document.cookie==="login=one; temporary=session"&&localStorage.saved==="one"&&storageEvents.length===1');
    await second.waitForFunction(()=>sandstone.controller.site_data.cookies.getCookieStringSync('https://host-state.test/').includes('secret=hidden'));
    const joining=await context.newPage();await open(joining,'/joining');
    assert.equal(await read(joining,'document.cookie'),'login=one; temporary=session','A joining host initialized before receiving session cookies');
    assert.ok(await joining.evaluate(()=>sandstone.controller.site_data.cookies.getCookieStringSync('https://host-state.test/').includes('secret=hidden')));
    await joining.close();
    assert.deepEqual(await read(second,'storageEvents'),[{key:'saved',oldValue:null,newValue:'one',url:origin+'/first',area:true}]);
    await write(first,`globalThis.writer=document.createElement('iframe');writer.srcdoc='<script>localStorage.setItem("child","srcdoc")<\\/script>';document.body.append(writer)`);
    await wait(second,'localStorage.child==="srcdoc"');
    assert.deepEqual(await read(second,'storageEvents.at(-1)'),{key:'child',oldValue:null,newValue:'srcdoc',url:childURL,area:true});
    await write(first,'writer.remove();storageEvents.length=0');
    await write(first,'localStorage.setItem("saved","one")');
    await second.waitForTimeout(50);assert.equal(await read(second,'storageEvents.length'),2);
    await first.evaluate(()=>history.replaceState(null,'',location.href.split('#')[0]));
    await first.reload();await open(first,'/reloaded');
    assert.deepEqual(await first.evaluate(origin=>{
      const store=sandstone.controller.site_data;
      return {cookie:store.cookies.getCookieStringSync(origin+'/'),local:store.local[origin]||[]};
    },legacyOrigin),{cookie:'',local:[]});
    assert.deepEqual(await read(first,'({cookie:document.cookie,value:localStorage.saved})'),{cookie:'login=one; temporary=session',value:'one'});
    assert.ok(await first.evaluate(()=>sandstone.controller.site_data.cookies.getCookieStringSync('https://host-state.test/').includes('secret=hidden')),'Reload lost an HttpOnly session cookie');
    await write(first,'localStorage.setItem("other","two");localStorage.clear()');
    await wait(second,'localStorage.length===0&&storageEvents.some(event=>event.key===null)');
    assert.deepEqual(await read(second,'storageEvents.at(-1)'),{key:null,oldValue:null,newValue:null,url:origin+'/reloaded',area:true});
    await second.evaluate(()=>{globalThis.oldCookieGeneration=sandstone.controller.site_data.cookieGeneration;});
    await first.evaluate(()=>sandstone.controller.site_data.clear('host-state.test'));
    await wait(second,'document.cookie===""');
    const late=await second.evaluate(()=>{
      const store=sandstone.controller.site_data;
      store.setLocal('https://unrelated.test',[['document','saved']]);
      return !!store.setCookie('https://host-state.test/','login=late; Max-Age=86400; Path=/',true,{cookieGeneration:oldCookieGeneration});
    });
    assert.equal(late,false,'An old host response restored a cleared cookie');
    await first.evaluate(()=>history.replaceState(null,'',location.href.split('#')[0]));
    await first.reload();await open(first,'/cleared');
    assert.deepEqual(await read(first,'({cookie:document.cookie,size:localStorage.length})'),{cookie:'',size:0});
    assert.deepEqual(errors,[]);
    return ['Independent standalone hosts synchronize cookies and storage events','Inherited-origin child storage events retain native source URLs across hosts','Existing and joining hosts share session cookies while keeping HttpOnly values private','Host reloads retain session cookies while keeping HttpOnly values private','Peer writes preserve durable site data across host reloads','Cross-host clears reject late cookies and cannot restore stale snapshots'];
  }finally{await context.close();}
}
