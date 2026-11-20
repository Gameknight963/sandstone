import assert from 'node:assert/strict';
const html='<!doctype html><script>globalThis.initialPreload=[];</script><link rel="preload" as="script" href="/initial.js" onload="initialPreload.push(this.getAttribute(\'href\'))"><body>Preload fixture';
const body=path=>path==='/page'?html:path==='/module.js'?'import {value} from "/dependency.js";globalThis.modulePreloadValue=value;':path==='/dependency.js'?'export const value=42;':path==='/image.svg'?'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>':'globalThis.preloadExecutions=(globalThis.preloadExecutions||0)+1;';
const type=path=>path==='/page'||path==='/bad-module.js'?'text/html':path==='/image.svg'?'image/svg+xml':'text/javascript';
async function exercise(){
  const wait=async check=>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw new Error('Preload condition timed out');await new Promise(resolve=>setTimeout(resolve,10));}};
  await wait(()=>initialPreload.length===1);const result={initial:initialPreload,executedBefore:globalThis.preloadExecutions||0,cases:[]};
  const preload=async(rel,as,href,cross)=>{
    const link=document.createElement('link');link.href=href;link.rel=rel;if(as)link.as=as;if(cross!==undefined)link.crossOrigin=cross;
    const event=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Preload timed out: '+href)),5000);for(const name of ['load','error'])link.addEventListener(name,()=>{clearTimeout(timer);resolve(name);},{once:true});document.head.append(link);});
    result.cases.push({rel,as,href,raw:link.getAttribute('href'),event});return link;
  };
  const classic=await preload('preload','script','/classic.js');
  result.executedAfterPreload=globalThis.preloadExecutions||0;
  await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=classic.href;script.onload=resolve;script.onerror=()=>reject(new Error('Preloaded script failed'));document.head.append(script);});
  result.executedAfterScript=globalThis.preloadExecutions;
  await preload('preload','fetch','/fetch');await preload('preload','image','/image.svg');await preload('preload','font','/font');await preload('preload','script','/anonymous.js','anonymous');
  await preload('preload','script','/missing.js');await preload('modulepreload','','/bad-module.js');
  await preload('modulepreload','','/module.js');result.moduleBefore=globalThis.modulePreloadValue??null;
  await new Promise((resolve,reject)=>{const script=document.createElement('script');script.type='module';script.src='/module.js';script.onload=resolve;script.onerror=()=>reject(new Error('Preloaded module failed'));document.head.append(script);});result.moduleAfter=globalThis.modulePreloadValue;
  const race=document.createElement('link');race.rel='preload';race.as='script';race.href='/slow.js';let events=0;race.onload=()=>events++;document.head.append(race);race.href='/winner.js';await wait(()=>events===1);await new Promise(resolve=>setTimeout(resolve,100));result.race=events;
  const removed=document.createElement('link');removed.rel='preload';removed.as='script';removed.href='/slow-removed.js';removed.onload=()=>events++;document.head.append(removed);removed.remove();await new Promise(resolve=>setTimeout(resolve,100));result.afterRemoval=events;
  const unsupported=document.createElement('link');unsupported.rel='preload';unsupported.as='script';unsupported.type='application/json';unsupported.href='/unsupported.js';unsupported.onload=()=>events++;unsupported.onerror=()=>events++;document.head.append(unsupported);await new Promise(resolve=>setTimeout(resolve,100));result.unsupported=events;
  return result;
}
export async function verifyLinkPreloads(page){
  const origin='https://preload.test',context=await page.context().browser().newContext(),native=await context.newPage(),fixture=await page.context().newPage(),nativeRequests=[],errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
  await context.route(origin+'/**',async route=>{const path=new URL(route.request().url()).pathname;nativeRequests.push(path);if(path.startsWith('/slow'))await new Promise(resolve=>setTimeout(resolve,60));await route.fulfill({status:path==='/missing.js'?404:200,headers:{'content-type':type(path),'cache-control':'no-store'},body:body(path)}).catch(()=>{});});
  try{
    await native.goto(origin+'/page');const expected=await native.evaluate(exercise);
    assert.equal(expected.executedAfterPreload,0);assert.equal(expected.executedAfterScript,1);assert.equal(expected.moduleBefore,null);assert.equal(expected.moduleAfter,42);assert.equal(expected.race,1);assert.equal(expected.afterRemoval,1);
    assert.equal(nativeRequests.filter(path=>path==='/classic.js').length,1);assert.equal(nativeRequests.filter(path=>path==='/module.js').length,1);
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.evaluate(async({origin,html})=>{
      globalThis.preloadRequests=[];
      sandstone.network.session.fetch=async url=>{const path=new URL(url).pathname;preloadRequests.push(path);if(path.startsWith('/slow'))await new Promise(resolve=>setTimeout(resolve,60));return new Response(path==='/page'?html:path==='/module.js'?'import {value} from "/dependency.js";globalThis.modulePreloadValue=value;':path==='/dependency.js'?'export const value=42;':path==='/image.svg'?'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>':'globalThis.preloadExecutions=(globalThis.preloadExecutions||0)+1;',{status:path==='/missing.js'?404:200,headers:{'content-type':path==='/page'||path==='/bad-module.js'?'text/html':path==='/image.svg'?'image/svg+xml':'text/javascript','cache-control':'no-store'}});};
      main_frame.on_load=()=>{};await main_frame.navigate_to(origin+'/page');
    },{origin,html});
    assert.deepEqual(await fixture.evaluate(source=>main_frame.eval_js(source),'('+exercise.toString()+')()'),expected);
    const requests=await fixture.evaluate(()=>preloadRequests);assert.equal(requests.filter(path=>path==='/classic.js').length,1);assert.equal(requests.filter(path=>path==='/module.js').length,1);
    assert.equal(nativeRequests.includes('/unsupported.js'),false);assert.equal(requests.includes('/unsupported.js'),false);
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Initial and dynamic script/image/font/fetch preloads deliver native completion events','Script preload promotion reuses no-store responses without executing early','Module preloads prepare dependencies without execution and retain module identity','Preload failures, URL races and removal suppress stale completion'];
  }finally{await context.close();await fixture.close();}
}
