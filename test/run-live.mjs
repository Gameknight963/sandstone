// Opt-in public-site checks. External availability/content makes these unsuitable
// as a required CI gate; the deterministic browser/relay suites remain separate.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
import {create_relay_server} from '../example/http.mjs';
import {server as wisp,logging} from '../example/node_modules/@mercuryworkshop/wisp-js/src/entrypoints/server.mjs';

const sites=[
  {id:'hn',url:'https://news.ycombinator.com/'},
  {id:'mdn',url:'https://developer.mozilla.org/en-US/docs/Web/JavaScript'},
  {id:'wikipedia',url:'https://en.wikipedia.org/wiki/Main_Page'},
  {id:'github',url:'https://github.com/octocat/Hello-World'},
  {id:'react',url:'https://react.dev/learn'},
  {id:'vue',url:'https://vuejs.org/guide/introduction.html'}
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
  throw new Error('Condition timed out: '+expression+(lastError?' ('+lastError.message+')':''));
}
const summary=(page,proxy)=>read(page,proxy,'({title:document.title,heading:document.querySelector("h1")?.textContent.trim()||"",links:document.links.length})');
async function interact(page,proxy,site){
  const surface=proxy?page.frameLocator('iframe[frame-id]'):page;
  if(site.id==='vue'){
    await wait(page,proxy,'!!document.getElementById("app")?.__vue_app__');
    await surface.getByRole('button',{name:'Count is: 0',exact:true}).click();
    await surface.getByRole('button',{name:'Count is: 1',exact:true}).waitFor();
    const counter=await surface.getByRole('button',{name:'Count is: 1',exact:true}).textContent();
    const dark=await read(page,proxy,'document.documentElement.classList.contains("dark")');
    await surface.locator('button[aria-label="Toggle dark mode"]:visible').first().click();
    await wait(page,proxy,'document.documentElement.classList.contains("dark")==='+JSON.stringify(!dark));
    await surface.locator('a[href="/guide/essentials/reactivity-fundamentals.html"]:visible').first().click();
    await wait(page,proxy,'location.pathname==="/guide/essentials/reactivity-fundamentals.html"&&document.querySelector("h1")?.textContent.includes("Reactivity Fundamentals")');
    return {...await read(page,proxy,'({path:location.pathname,heading:document.querySelector("h1").textContent.trim(),dark:document.documentElement.classList.contains("dark"),font:getComputedStyle(document.querySelector("h1")).fontFamily,fontSize:getComputedStyle(document.querySelector("h1")).fontSize})'),counter:counter.trim()};
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
    await surface.locator('a[href="/learn/installation"]:visible').first().click();
    await wait(page,proxy,'location.pathname==="/learn/installation"&&document.title.includes("Installation")');
    return {...await read(page,proxy,'({path:location.pathname,title:document.title})'),counters};
  }
  if(site.id==='github'){
    await surface.locator('a[href="/octocat/Hello-World/blob/master/README"]:visible').first().click();
    await wait(page,proxy,'location.pathname==="/octocat/Hello-World/blob/master/README"&&Array.from(document.querySelectorAll("a")).some(link=>link.textContent.trim()==="Raw")');
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
  });
  return value;
}
try{
  const channel=process.env.BROWSER_CHANNEL||'chrome';
  browser=await chromium.launch({headless:true,channel:channel==='headless'?undefined:channel});
  for(const site of targets){
    // Compare the site's ordinary native behavior with a standalone host whose
    // real storage may be denied. Proxied sites should still have virtual stores.
    const result={site:site.id,url:site.url,storageDenied},nativeContext=await context(false);
    try{
      const native=await nativeContext.newPage();
      const response=await native.goto(site.url,{waitUntil:'domcontentloaded'});
      assert.ok(response.ok(),'Native page returned '+response.status());
      await native.waitForTimeout(1000);
      result.native={status:response.status(),...await summary(native,false),interaction:await deadline(interact(native,false,site),'Native interaction',site.id==='react'?40000:25000)};
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
      await page.evaluate(port=>sandstone.network.set_websocket('ws://127.0.0.1:'+port+'/'),server.address().port);
      await deadline(page.evaluate(url=>main_frame.navigate_to(url),site.url),'Proxy navigation');
      await page.waitForTimeout(1000);
      result.proxy={...await summary(page,true),interaction:await deadline(interact(page,true,site),'Proxy interaction',site.id==='react'?40000:25000)};
      assert.equal(result.proxy.title,result.native.title,'Initial document title differs');
      assert.ok(result.proxy.links>0,'No proxied links rendered');
      assert.deepEqual(result.proxy.interaction,result.native.interaction,'Interaction result differs from native');
      assert.deepEqual(direct,[],'A proxied page attempted direct HTTP');
      assert.deepEqual(errors,[],'A proxied page raised script errors');
      result.status=diagnostics.length?'passed-with-diagnostics':'passed';
    }catch(error){result.status='failed';result.error=error.message;}
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
  await browser?.close();for(const socket of connections)socket.destroy();
  await new Promise(resolve=>server.close(resolve));
}
