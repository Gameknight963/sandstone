import assert from 'node:assert/strict';

const origin='https://fragment-navigation.test';
const cases=[
  {id:'input',target:'field',body:'<input id="field"><input id="next">'},
  {id:'section',target:'section',body:'<div id="section">Section</div><input id="next">'},
  {id:'backward',target:'section',backward:true,body:'<input id="previous"><div id="section">Section</div><input id="next">'},
  {id:'tabindex',target:'section',body:'<div id="section" tabindex="-1">Section</div><input id="next">'},
  {id:'editable',target:'section',body:'<div id="section" contenteditable>Section</div><input id="next">'},
  {id:'named-input',target:'named',body:'<input id="field" name="named"><input id="next">'},
  {id:'named-anchor',target:'named',body:'<a name="named">Section</a><input id="next">'},
  {id:'encoded',target:'caf%C3%A9',body:'<input id="café"><input id="next">'},
  {id:'raw-percent',target:'caf%C3%A9',body:'<input id="café"><input id="caf%C3%A9"><input id="next">'},
  {id:'missing',target:'missing',body:'<input id="field"><input id="next">'},
  {id:'top',target:'top',body:'<input id="field"><input id="next">'},
  {id:'top-element',target:'top',body:'<input id="top"><input id="next">'},
  {id:'empty',target:'',body:'<input id="field"><input id="next">'},
  {id:'details',target:'inside',body:'<details><summary>Summary</summary><input id="inside"></details><input id="next">'},
  {id:'until-found',target:'inside',body:'<div id="hidden" hidden="until-found"><input id="inside"></div><input id="next">'},
  {id:'svg',target:'shape',body:'<svg><rect id="shape" tabindex="0" width="10" height="10"></rect></svg><input id="next">'},
  {id:'replace',target:'field',method:'replace',body:'<input id="field"><input id="next">'},
  {id:'override',target:'field',body:'<input id="field"><input id="next"><script>document.getElementById("field").focus=()=>{throw Error("author focus override")};Element.prototype.scrollIntoView=()=>{throw Error("author scroll override")};</script>'},
  {id:'initial',target:'field',initial:true,body:'<input id="field"><input id="next">'},
  {id:'initial-section',target:'section',initial:true,body:'<div id="section">Section</div><input id="next">'},
  {id:'state-methods',target:'field',stateMethods:true,body:'<input id="field"><input id="second"><input id="next">'},
  {id:'skip-link',target:'field',click:true,body:'<a id="jump" href="#field">Skip to field</a><input id="field"><input id="next">'}
];
for(const id of ['input','section','named-anchor','details']){
  const test=cases.find(test=>test.id===id);cases.push({...test,id:'srcdoc-'+id,nested:true});
}
const html=test=>'<!doctype html><style>:target{outline:3px solid red}body{min-height:3000px}#spacer{height:1100px}</style><body><input id="start"><a id="before" href="#">Before</a><div id="spacer"></div>'+test.body+'<script>globalThis.events=[];for(const type of ["focusin","focusout","beforematch","popstate","hashchange"])addEventListener(type,event=>events.push({type,id:event.target.id||null,...(type==="hashchange"?{old:event.oldURL,url:event.newURL}:{}),...(type==="popstate"?{state:event.state}:{})}));</script>';
const snapshot='({active:document.activeElement.id,target:document.querySelector(":target")?.id||null,events,details:document.querySelector("details")?.open,hidden:document.getElementById("hidden")?.getAttribute("hidden"),outline:document.querySelector(":target")&&getComputedStyle(document.querySelector(":target")).outlineWidth,scroll:Math.round(scrollY)})';
const documentHTML=test=>test.nested?'<!doctype html><iframe id="nested" style="border:0;width:100%;height:100vh" srcdoc="'+html(test).replaceAll('&','&amp;').replaceAll('"','&quot;')+'"></iframe>':html(test);

export async function verifyFragmentNavigation(page,{batch=0,batches=1}={}){
  const selected=cases.filter((_,index)=>index%batches===batch),nativeContext=await page.context().browser().newContext({viewport:page.viewportSize()}),errors=[],direct=[];
  let native;
  const onError=error=>errors.push(error.message),onRequest=request=>{if(/^https?:/.test(request.url()))direct.push(request.url());};
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const read=async(proxy,source)=>JSON.parse(await evaluate(proxy,'JSON.stringify('+source+')'));
  await nativeContext.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:documentHTML(cases.find(test=>'/'+test.id===new URL(route.request().url()).pathname))}));
  try{
    await page.evaluate(({origin,documents})=>{
      globalThis.fragmentPrevious=sandstone.network.session.fetch;
      sandstone.network.session.fetch=(url,options)=>new URL(url).origin===origin?Promise.resolve(new Response(documents[new URL(url).pathname],{headers:{'content-type':'text/html'}})):fragmentPrevious(url,options);
    },{origin,documents:Object.fromEntries(cases.map(test=>['/'+test.id,documentHTML(test)]))});
    page.on('pageerror',onError);page.on('request',onRequest);
    for(const test of selected){
      // Isolate native history and focus between scenarios.
      await native?.close();native=await nativeContext.newPage();
      const url=origin+'/'+test.id+(test.initial?'#'+test.target:'');
      const source=value=>test.nested?'document.getElementById("nested").contentWindow.eval('+JSON.stringify(value)+')':value;
      const results=[];
      for(const proxy of [false,true]){
        const surface=proxy?page:native;await surface.bringToFront();
        if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),url);else await native.goto(url);
        // Settle the initial paint/viewport before comparing fragment scrolling.
        await evaluate(proxy,source('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))'));
        const physicalLength=await surface.evaluate(()=>history.length),physicalURL=surface.url();
        if(!test.initial){
          await evaluate(proxy,source('document.getElementById("start").focus();events=[];true'));
          if(test.click)await (proxy?page.frameLocator('iframe[frame-id]'):native).locator('#jump').click();
          else await evaluate(proxy,source((test.method==='replace'?'location.replace('+JSON.stringify('#'+test.target)+')':'location.hash='+JSON.stringify(test.target))+';true'));
        }
        await surface.waitForTimeout(100);
        const before=await read(proxy,source(snapshot));
        await surface.keyboard.press(test.backward?'Shift+Tab':'Tab');
        const after=await read(proxy,source('document.activeElement.id'));
        const states=[];
        if(test.stateMethods){
          for(const command of ['history.pushState({saved:true},"","#second")','history.replaceState({saved:2},"","#missing")']){
            await evaluate(proxy,command+';true');await surface.waitForTimeout(100);
            states.push(await read(proxy,snapshot));await evaluate(proxy,'events=[];true');
          }
        }
        results.push({before,after,...(test.stateMethods?{states}:{})});
        if(proxy){
          assert.equal(await surface.evaluate(()=>history.length),physicalLength,'Fragments added physical browser history');
          assert.equal(surface.url(),physicalURL,'A fragment changed the standalone host URL');
        }
      }
      assert.deepEqual(results[1],results[0],'Fragment navigation differs: '+test.id);
      if(test.id==='input')assert.equal(results[0].before.active,'field');
      if(test.id==='section')assert.equal(results[0].after,'next');
    }
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return selected.map(test=>'Native fragment navigation: '+test.id);
  }finally{
    page.off('pageerror',onError);page.off('request',onRequest);
    await page.evaluate(()=>{if(globalThis.fragmentPrevious){sandstone.network.session.fetch=fragmentPrevious;delete globalThis.fragmentPrevious;}});
    await nativeContext.close();await page.bringToFront();
  }
}
