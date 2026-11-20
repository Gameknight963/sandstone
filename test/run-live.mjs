// Opt-in public-site checks. External availability/content makes these unsuitable
// as a required CI gate; the deterministic browser/relay suites remain separate.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
import {create_relay_server} from '../example/http.mjs';
import {server as wisp,logging} from '../example/node_modules/@mercuryworkshop/wisp-js/src/entrypoints/server.mjs';
import {track_client_sockets} from './client-sockets.mjs';
import {interact_editor} from './live-editors.mjs';
import {tool_sites,interact_tool} from './live-tools.mjs';

const sites=[
  ...tool_sites,
  {id:'photopea',url:'https://www.photopea.com/',editor:true},
  {id:'desmos',url:'https://www.desmos.com/calculator',editor:true},
  {id:'jspaint',url:'https://jspaint.app/',editor:true},
  {id:'mermaid',url:'https://mermaid.live/',editor:true},
  {id:'diagrams',url:'https://app.diagrams.net/',editor:true},
  {id:'discourse',url:'https://discuss.python.org/latest'},
  {id:'openstreetmap',url:'https://www.openstreetmap.org/#map=5/39.828/-98.579'},
  {id:'mastodon',url:'https://mastodon.social/explore'},
  {id:'excalidraw',url:'https://excalidraw.com/'},
  {id:'hn',url:'https://news.ycombinator.com/'},
  {id:'mdn',url:'https://developer.mozilla.org/en-US/docs/Web/JavaScript'},
  {id:'wikipedia',url:'https://en.wikipedia.org/wiki/Main_Page'},
  {id:'github',url:'https://github.com/octocat/Hello-World'},
  {id:'react',url:'https://react.dev/learn'},
  {id:'vue',url:'https://vuejs.org/guide/introduction.html'},
  {id:'svelte',url:'https://svelte.dev/docs/svelte/overview'},
  {id:'angular',url:'https://angular.dev/overview'}
];
const selected=process.argv.slice(2);
for(const id of selected)if(!sites.some(site=>site.id===id))throw new Error('Unknown live site: '+id+'; choose '+sites.map(site=>site.id).join(', '));
const targets=sites.filter(site=>!selected.length||selected.includes(site.id));
const storageDenied=process.env.LIVE_STORAGE_DENIED==='1';
const artifact=pathToFileURL(fileURLToPath(new URL('../example/bundled.html',import.meta.url))).href;
const reportURL=new URL('../.temp/live-compatibility'+(storageDenied?'-storage-denied':'')+'.json',import.meta.url);
const results=[];
const server=create_relay_server((request,response)=>{response.writeHead(404);response.end();});
const connections=new Set();
server.on('connection',socket=>{connections.add(socket);socket.on('close',()=>connections.delete(socket));});
server.on('upgrade',(request,socket,head)=>wisp.routeRequest(request,socket,head));
server.listen(0,'127.0.0.1');await once(server,'listening');
// The test relay is loopback-only and forwards only ordinary public web ports.
wisp.options.port_whitelist=[80,443];wisp.options.allow_loopback_ips=false;
logging.set_level(logging.WARN);
let browser;
const closeClientSockets=track_client_sockets();
function deadline(operation,label,ms=25000){
  let timer;
  return Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timed out')),ms);})]).finally(()=>clearTimeout(timer));
}
async function read(page,proxy,expression){
  const source='JSON.stringify('+expression+')';
  return JSON.parse(proxy?await page.evaluate(source=>main_frame.eval_js(source),source):await page.evaluate(source=>eval(source),source));
}
async function wait(page,proxy,expression){
  const expires=Date.now()+15000;let lastError;
  while(Date.now()<expires){
    try{
      const navigating=proxy&&await page.evaluate(()=>main_frame.is_navigating);
      if(!navigating&&await read(page,proxy,expression))return;
    }catch(error){lastError=error;}
    await page.waitForTimeout(100);
  }
  let state;
  try{state=await deadline(read(page,proxy,'({url:location.href,heading:document.querySelector("h1")?.textContent.trim(),readyState:document.readyState})'),'Timeout diagnostics',2000);}catch{}
  throw new Error('Condition timed out: '+expression+(state?' '+JSON.stringify(state):'')+(lastError?' ('+lastError.message+')':''));
}
const summary=(page,proxy)=>read(page,proxy,'({title:document.title,heading:document.querySelector("h1")?.textContent.trim()||"",links:document.links.length})');
async function interact(page,proxy,site){
  const surface=proxy?page.frameLocator('iframe[frame-id]'):page;
  if(tool_sites.some(tool=>tool.id===site.id))return interact_tool(page,proxy,site,{surface,read,wait});
  if(site.editor)return interact_editor(page,proxy,site,{surface,read,wait});
  if(site.id==='excalidraw'){
    await surface.getByRole('button',{name:'Rectangle',exact:true}).click();
    const box=await surface.locator('canvas.interactive').boundingBox();
    assert.ok(box,'Excalidraw interactive canvas is unavailable');
    const x=box.x+box.width*.55,y=box.y+box.height*.5;
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+120,y+80,{steps:8});await page.mouse.up();
    const count='JSON.parse(localStorage.getItem("excalidraw")||"[]").filter(shape=>shape.type==="rectangle"&&!shape.isDeleted).length';
    await wait(page,proxy,count+'===1');
    const shapes=await read(page,proxy,'JSON.parse(localStorage.getItem("excalidraw")).filter(shape=>!shape.isDeleted).map(shape=>({type:shape.type,width:shape.width,height:shape.height}))');
    await surface.getByRole('button',{name:'Undo',exact:true}).click();await wait(page,proxy,count+'===0');
    await surface.getByRole('button',{name:'Redo',exact:true}).click();await wait(page,proxy,count+'===1');
    if(proxy){
      const navigation=await page.evaluate(()=>main_frame.navigation_id);
      await page.evaluate(()=>main_frame.eval_js('setTimeout(()=>location.reload(),0);true'));
      await page.waitForFunction(id=>main_frame.navigation_id>id&&!main_frame.is_navigating,navigation);
    }else await page.reload({waitUntil:'domcontentloaded'});
    await surface.getByRole('button',{name:'Rectangle',exact:true}).waitFor();await wait(page,proxy,count+'===1');
    const restored=await read(page,proxy,'JSON.parse(localStorage.getItem("excalidraw")).filter(shape=>!shape.isDeleted).map(shape=>({type:shape.type,width:shape.width,height:shape.height}))');
    assert.deepEqual(restored,shapes,'Excalidraw lost saved scene geometry after reload');
    return {shapes,undo:true,redo:true,reloaded:true};
  }
  if(site.id==='openstreetmap'){
    await wait(page,proxy,'Array.from(document.querySelectorAll("img.leaflet-tile-loaded")).some(image=>image.complete&&image.naturalWidth>0)');
    const map=surface.locator('.leaflet-container');await map.focus();await map.press('Equal');
    await wait(page,proxy,'location.hash.startsWith("#map=6/")');
    return read(page,proxy,'({zoom:location.hash.split("/")[0],tiles:Array.from(document.querySelectorAll("img.leaflet-tile-loaded")).some(image=>image.complete&&image.naturalWidth>0)})');
  }
  if(site.id==='mastodon'){
    await wait(page,proxy,'document.querySelectorAll("article[data-variant=feed]").length>0');
    await (proxy?page.evaluate(()=>main_frame.eval_js('window.liveNavigationMarker="persisted"')):page.evaluate(()=>window.liveNavigationMarker='persisted'));
    await surface.locator('a[href="/explore/tags"]').click();
    await wait(page,proxy,'location.pathname==="/explore/tags"&&Array.from(document.links).some(link=>link.getAttribute("href")?.startsWith("/tags/"))');
    const clientNavigation=await read(page,proxy,'window.liveNavigationMarker==="persisted"');
    assert.equal(clientNavigation,true,'Mastodon navigation reloaded the document');
    await (proxy?page.evaluate(()=>main_frame.eval_js('history.back();true')):page.evaluate(()=>history.back()));
    await wait(page,proxy,'location.pathname==="/explore"&&document.querySelectorAll("article[data-variant=feed]").length>0');
    return {feed:true,tags:true,returned:true,clientNavigation};
  }
  if(site.id==='discourse'){
    await wait(page,proxy,'document.querySelectorAll(".topic-list-item a.title").length>0');
    await (proxy?page.evaluate(()=>main_frame.eval_js('window.liveNavigationMarker="persisted"')):page.evaluate(()=>window.liveNavigationMarker='persisted'));
    await surface.locator('.topic-list-item a.title').first().click();
    await wait(page,proxy,'location.pathname.startsWith("/t/")&&document.querySelectorAll(".topic-post").length>0');
    const clientNavigation=await read(page,proxy,'window.liveNavigationMarker==="persisted"');
    assert.equal(clientNavigation,true,'Discourse topic navigation reloaded the document');
    await (proxy?page.evaluate(()=>main_frame.eval_js('history.back();true')):page.evaluate(()=>history.back()));
    await wait(page,proxy,'location.pathname==="/latest"&&document.querySelectorAll(".topic-list-item a.title").length>0');
    return {topic:true,returned:true,clientNavigation};
  }
  if(site.id==='angular'){
    const theme=surface.getByRole('button',{name:/^Change theme\. Current theme:/});
    await theme.click();
    await surface.getByRole('menuitemradio',{name:'Set dark theme',exact:true}).click();
    await wait(page,proxy,'document.querySelector(\'button[aria-label^="Change theme. Current theme:"]\')?.getAttribute("aria-label")==="Change theme. Current theme: dark"');
    await (proxy?page.evaluate(()=>main_frame.eval_js('window.liveNavigationMarker="persisted"')):page.evaluate(()=>window.liveNavigationMarker='persisted'));
    await surface.locator('a[href="essentials/components"]:visible').first().click();
    await wait(page,proxy,'location.pathname==="/essentials/components"&&document.querySelector("h1")?.textContent.trim()==="Components"');
    await (proxy?page.evaluate(()=>main_frame.eval_js('history.back();true')):page.evaluate(()=>history.back()));
    await wait(page,proxy,'location.pathname==="/overview"&&document.querySelector("h1")?.textContent.trim()==="What is Angular?"');
    await (proxy?page.evaluate(()=>main_frame.eval_js('history.forward();true')):page.evaluate(()=>history.forward()));
    await wait(page,proxy,'location.pathname==="/essentials/components"&&document.querySelector("h1")?.textContent.trim()==="Components"');
    const result=await read(page,proxy,'({path:location.pathname,heading:document.querySelector("h1").textContent.trim(),clientNavigation:window.liveNavigationMarker==="persisted",theme:document.querySelector(\'button[aria-label^="Change theme. Current theme:"]\').getAttribute("aria-label")})');
    assert.equal(result.clientNavigation,true,'Angular navigation reloaded the document');
    return result;
  }
  if(site.id==='svelte'){
    // Current Svelte stores delegated handlers under a symbol on the element.
    // SSR paints this button before hydration installs its click handler.
    await wait(page,proxy,'(()=>{const button=document.querySelector(\'button[aria-label="Toggle dark mode"]\');return !!button&&Reflect.ownKeys(button).some(key=>typeof key==="symbol"&&typeof button[key]?.click==="function");})()');
    const theme=surface.locator('button[aria-label="Toggle dark mode"]:visible').first();
    const pressed=await theme.getAttribute('aria-pressed');
    await theme.click();
    await wait(page,proxy,'Array.from(document.querySelectorAll(\'button[aria-label="Toggle dark mode"]\')).some(button=>button.getAttribute("aria-pressed")!=='+JSON.stringify(pressed)+')');
    await (proxy?page.evaluate(()=>main_frame.eval_js('window.liveNavigationMarker="persisted"')):page.evaluate(()=>window.liveNavigationMarker='persisted'));
    await surface.locator('a[href="/docs/svelte/getting-started"]:visible').first().click();
    await wait(page,proxy,'location.pathname==="/docs/svelte/getting-started"&&document.querySelector("h1")?.textContent.trim()==="Getting started"');
    await surface.getByPlaceholder('Search',{exact:true}).fill('onMount');
    await surface.locator('a[href="/docs/svelte/lifecycle-hooks#onMount"]:visible').first().click();
    await wait(page,proxy,'location.pathname==="/docs/svelte/lifecycle-hooks"&&location.hash==="#onMount"&&document.querySelector("h1")?.textContent.trim()==="Lifecycle hooks"');
    await (proxy?page.evaluate(()=>main_frame.eval_js('history.back();true')):page.evaluate(()=>history.back()));
    await wait(page,proxy,'location.pathname==="/docs/svelte/getting-started"&&document.querySelector("h1")?.textContent.trim()==="Getting started"');
    await (proxy?page.evaluate(()=>main_frame.eval_js('history.forward();true')):page.evaluate(()=>history.forward()));
    await wait(page,proxy,'location.pathname==="/docs/svelte/lifecycle-hooks"&&location.hash==="#onMount"&&document.querySelector("h1")?.textContent.trim()==="Lifecycle hooks"');
    const result=await read(page,proxy,'({path:location.pathname,hash:location.hash,title:document.title,heading:document.querySelector("h1").textContent.trim(),clientNavigation:window.liveNavigationMarker==="persisted",theme:document.querySelector(\'button[aria-label="Toggle dark mode"]\').getAttribute("aria-pressed")})');
    assert.equal(result.clientNavigation,true,'Svelte navigation reloaded the document');
    return result;
  }
  if(site.id==='vue'){
    await wait(page,proxy,'!!document.getElementById("app")?.__vue_app__');
    await surface.getByRole('button',{name:'Count is: 0',exact:true}).click();
    await surface.getByRole('button',{name:'Count is: 1',exact:true}).waitFor();
    const counter=await surface.getByRole('button',{name:'Count is: 1',exact:true}).textContent();
    const dark=await read(page,proxy,'document.documentElement.classList.contains("dark")');
    await surface.locator('button[aria-label="Toggle dark mode"]:visible').first().click();
    await wait(page,proxy,'document.documentElement.classList.contains("dark")==='+JSON.stringify(!dark));
    await (proxy?page.evaluate(()=>main_frame.eval_js('window.liveNavigationMarker="persisted"')):page.evaluate(()=>window.liveNavigationMarker='persisted'));
    await surface.locator('a[href="/guide/essentials/reactivity-fundamentals.html"]:visible').first().click();
    await wait(page,proxy,'location.pathname==="/guide/essentials/reactivity-fundamentals.html"&&document.querySelector("h1")?.textContent.includes("Reactivity Fundamentals")');
    const result={...await read(page,proxy,'({path:location.pathname,heading:document.querySelector("h1").textContent.trim(),dark:document.documentElement.classList.contains("dark"),font:getComputedStyle(document.querySelector("h1")).fontFamily,fontSize:getComputedStyle(document.querySelector("h1")).fontSize,clientNavigation:window.liveNavigationMarker==="persisted"})'),counter:counter.trim()};
    assert.equal(result.clientNavigation,true,'Vue navigation reloaded the document');return result;
  }
  if(site.id==='react'){
    // Compile the final embedded example and exercise shared React state before
    // testing article navigation. Every resource must stay behind the relay.
    await surface.locator('iframe').last().scrollIntoViewIfNeeded();
    const counter=surface.frameLocator('iframe').last();
    const button=counter.getByRole('button',{name:'Clicked 0 times',exact:true}).first();
    await button.waitFor({state:'visible',timeout:25000});await button.click();
    await counter.getByRole('button',{name:'Clicked 1 times',exact:true}).first().waitFor();
    const counters=await counter.locator('button').allTextContents();
    await (proxy?page.evaluate(()=>main_frame.eval_js('window.liveNavigationMarker="persisted"')):page.evaluate(()=>window.liveNavigationMarker='persisted'));
    await surface.locator('a[href="/learn/installation"]:visible').first().click();
    await wait(page,proxy,'location.pathname==="/learn/installation"&&document.title.includes("Installation")');
    const result={...await read(page,proxy,'({path:location.pathname,title:document.title,clientNavigation:window.liveNavigationMarker==="persisted"})'),counters};
    assert.equal(result.clientNavigation,true,'React navigation reloaded the document');return result;
  }
  if(site.id==='github'){
    await surface.locator('a[href="/octocat/Hello-World/blob/master/README"]:visible').first().click();
    // GitHub can render its file toolbar before the streamed file contents.
    await wait(page,proxy,'location.pathname==="/octocat/Hello-World/blob/master/README"&&Array.from(document.querySelectorAll("a")).some(link=>link.textContent.trim()==="Raw")&&document.body.innerText.includes("Hello World!")');
    return read(page,proxy,'({path:location.pathname,title:document.title,file:document.body.innerText.includes("Hello World!")})');
  }
  if(site.id==='hn'){
    await surface.locator('.pagetop a[href="newest"]').first().click();
    await wait(page,proxy,'location.pathname==="/newest"&&document.querySelectorAll("tr.athing").length>0');
    return read(page,proxy,'({path:location.pathname,stories:document.querySelectorAll("tr.athing").length})');
  }
  if(site.id==='mdn'){
    await surface.locator('mdn-search-button button:visible').first().click();
    await surface.getByRole('combobox',{name:'Search',exact:true}).fill('fetch');
    // The initial fallback is a general site-search link. Wait for a document
    // suggestion so native/proxy runs exercise the same completed autocomplete.
    const result=surface.getByRole('option').locator('a[href^="/en-US/docs/"]').first();
    await result.waitFor({state:'visible'});await result.click();
    await wait(page,proxy,'location.pathname!=='+JSON.stringify(new URL(site.url).pathname)+'&&!!document.querySelector("h1")');
    return read(page,proxy,'({path:location.pathname,heading:document.querySelector("h1").textContent.trim()})');
  }
  await surface.locator('#skin-client-pref-skin-theme-value-night').check();
  await wait(page,proxy,'document.documentElement.classList.contains("skin-theme-clientpref-night")');
  return read(page,proxy,'({dark:document.documentElement.classList.contains("skin-theme-clientpref-night"),checked:document.getElementById("skin-client-pref-skin-theme-value-night").checked})');
}
async function context(denyStorage=storageDenied){
  const value=await browser.newContext();value.setDefaultTimeout(15000);value.setDefaultNavigationTimeout(20000);
  if(denyStorage)await value.addInitScript(()=>{
    Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Storage denied','SecurityError');}});
    Object.defineProperty(window,'indexedDB',{get(){throw new DOMException('Storage denied','SecurityError');}});
    Object.defineProperty(window,'caches',{configurable:true,get(){throw new DOMException('Storage denied','SecurityError');}});
  });
  return value;
}
try{
  const channel=process.env.BROWSER_CHANNEL||'chrome';
  browser=await chromium.launch({headless:true,channel:channel==='headless'?undefined:channel});
  const browserDiagnostics=await browser.newBrowserCDPSession();
  await browserDiagnostics.send('Target.setDiscoverTargets',{discover:true});
  browserDiagnostics.on('Target.targetCrashed',event=>console.log(JSON.stringify({browserCrash:{status:event.status,errorCode:event.errorCode}})));
  for(const site of targets){
    // Compare the site's ordinary native behavior with a standalone host whose
    // real storage may be denied. Proxied sites should still have virtual stores.
    const result={site:site.id,url:site.url,storageDenied},nativeContext=await context(false);
    try{
      const native=await nativeContext.newPage();
      const response=await native.goto(site.url,{waitUntil:'domcontentloaded'});
      assert.ok(response.ok(),'Native page returned '+response.status());
      await native.waitForTimeout(1000);
      const interaction=await deadline(interact(native,false,site),'Native interaction',site.id==='react'?40000:25000);
      result.native={status:response.status(),...await summary(native,false),interaction};
    }catch(error){result.status='baseline-unavailable';result.error=error.message;}
    finally{await nativeContext.close();}
    if(!result.native){results.push(result);console.log(JSON.stringify(result));continue;}
    const proxyContext=await context(),page=await proxyContext.newPage(),errors=[],diagnostics=[],direct=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error')diagnostics.push(message.text());});
    page.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
    // Fail closed if a page tries to bypass the relay for HTTP resources.
    await page.route(/^https?:/,route=>route.abort('blockedbyclient'));
    try{
      await page.goto(artifact);
      await page.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
      await page.evaluate(()=>{
        const session=sandstone.network.session,fetch=session.fetch;globalThis.liveRequestProgress=[];
        session.fetch=function(url,...args){
          const record={url:String(url),phase:'waiting for headers'};liveRequestProgress.push(record);
          return fetch.call(this,url,...args).then(response=>{record.phase='headers received';record.status=response.status;return response;},error=>{record.phase='failed';record.error=String(error);throw error;});
        };
      });
      await page.evaluate(port=>sandstone.network.set_websocket('ws://127.0.0.1:'+port+'/'),server.address().port);
      await deadline(page.evaluate(url=>main_frame.navigate_to(url),site.url),'Proxy navigation');
      await page.waitForTimeout(1000);
      const interaction=await deadline(interact(page,true,site),'Proxy interaction',site.id==='react'?40000:25000);
      result.proxy={...await summary(page,true),interaction};
      assert.equal(result.proxy.title,result.native.title,'Document title differs after interaction');
      if(!site.editor)assert.ok(result.proxy.links>0,'No proxied links rendered');
      assert.deepEqual(result.proxy.interaction,result.native.interaction,'Interaction result differs from native');
      assert.deepEqual(direct,[],'A proxied page attempted direct HTTP');
      assert.deepEqual(errors,[],'A proxied page raised script errors');
      result.status=diagnostics.length?'passed-with-diagnostics':'passed';
    }catch(error){
      result.status='failed';result.error=error.message;
      try{result.progress=await deadline(page.evaluate(()=>({navigating:main_frame.is_navigating,url:String(main_frame.url),requests:liveRequestProgress.filter(record=>record.phase==='waiting for headers'),recent:liveRequestProgress.slice(-10)})),'Failure diagnostics',2000);}catch{}
    }
    finally{
      result.scriptErrors=[...new Set(errors)];result.consoleDiagnostics=[...new Set(diagnostics)];result.directHTTP=[...new Set(direct)];
      await proxyContext.close();
    }
    results.push(result);console.log(JSON.stringify(result));
  }
  await mkdir(new URL('../.temp/',import.meta.url),{recursive:true});
  await writeFile(reportURL,JSON.stringify({checkedAt:new Date().toISOString(),results},null,2)+'\n');
  if(results.some(result=>!result.status.startsWith('passed')))process.exitCode=1;
}finally{
  try{await browser?.close();}
  finally{
    for(const socket of connections)socket.destroy();closeClientSockets();
    await new Promise(resolve=>server.close(resolve));
  }
}
