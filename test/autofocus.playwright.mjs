import assert from 'node:assert/strict';

const origin='https://autofocus-native.test',cross='https://cross-autofocus-native.test';
// Chrome still reports its physical cross-origin iframe limitation before
// the virtual document processes the same candidates. Keep that diagnostic
// scoped to these deliberate native/proxy comparisons, alongside policy denials.
const diagnostics=['Permissions policy violation: focus-without-user-activation is not allowed in this document.',...['input','div','rect','iframe'].map(tag=>'Blocked autofocusing on a <'+tag+'> element in a cross-origin subframe.')];
const children={
  '/child':'<!doctype html><body><input id="inside" autofocus>',
  '/ordered-child':'<!doctype html><body><input id="inside" autofocus><script>const field=parent.document.createElement("input");field.id="parent-later";field.autofocus=true;parent.document.body.append(field);</script>',
  '/fragment-child':'<!doctype html><body><div id="anchor">Anchor</div><input id="inside" autofocus>',
  '/empty':'<!doctype html><body>Empty frame',
  '/nested-child':'<!doctype html><body><iframe id="inner" allow="focus-without-user-activation *" src="/child"></iframe>'
};
const scenarios=[
  {id:'initial',body:'<input id="first" autofocus><input id="second" autofocus>'},
  {id:'disabled',body:'<input id="first" autofocus disabled><input id="second" autofocus>'},
  {id:'hidden',body:'<input id="first" autofocus hidden><input id="second" autofocus>'},
  {id:'unfocusable',body:'<div id="first" autofocus></div><input id="second" autofocus>'},
  {id:'manual',body:'<input id="manual"><input id="first" autofocus><script>document.getElementById("manual").focus()</script>'},
  {id:'manual-blur',body:'<input id="manual"><input id="first" autofocus><script>const field=document.getElementById("manual");field.focus();field.blur()</script>'},
  {id:'manual-body',body:'<input id="first" autofocus><script>document.body.id="manual-body";document.body.tabIndex=0;document.body.focus()</script>'},
  {id:'removed-flag',body:'<input id="first" autofocus><script>document.getElementById("first").removeAttribute("autofocus")</script>'},
  {id:'late-flag',body:'<input id="first"><script>document.getElementById("first").autofocus=true</script>'},
  {id:'dynamic',body:'<script>setTimeout(()=>{const field=document.createElement("input");field.id="first";field.autofocus=true;document.body.append(field);},20)</script>'},
  {id:'removed-node',body:'<input id="first" autofocus><input id="second" autofocus><script>document.getElementById("first").remove()</script>'},
  {id:'reinserted',body:'<input id="first" autofocus><input id="second" autofocus><script>document.body.append(document.getElementById("first"))</script>'},
  {id:'fragment-insert',body:'<template id="template"><input id="first" autofocus><input id="second" autofocus></template><script>document.body.append(document.getElementById("template").content.cloneNode(true))</script>'},
  {id:'processed',body:'<input id="first" autofocus onfocus="setTimeout(()=>{this.remove();const field=document.createElement(\'input\');field.id=\'second\';field.autofocus=true;document.body.append(field);},20)">'},
  {id:'fragment',hash:'#anchor',body:'<div id="anchor">Anchor</div><input id="first" autofocus>'},
  {id:'missing-fragment',hash:'#missing',body:'<input id="first" autofocus>'},
  {id:'closed-shadow',body:'<div id="host"></div><script>const root=document.getElementById("host").attachShadow({mode:"closed"});root.innerHTML="<input id=first autofocus>";</script>'},
  {id:'editable',body:'<div id="first" contenteditable autofocus>hello</div>'},
  {id:'overridden-focus',body:'<input id="first" autofocus><script>globalThis.focusCalls=0;document.getElementById("first").focus=()=>focusCalls++;</script>'},
  {id:'stylesheet',head:'<link rel="stylesheet" href="/hide.css">',body:'<input id="first" autofocus><input id="second" autofocus>'},
  {id:'print-stylesheet',head:'<link rel="stylesheet" href="/hide.css" media="print">',body:'<input id="first" autofocus><input id="second" autofocus>'},
  {id:'svg',body:'<svg><rect id="first" autofocus tabindex="0" width="20" height="20"></rect></svg><input id="second" autofocus>'},
  {id:'image-input',body:'<input id="first" type="image" autofocus src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2720%27 height=%2720%27/%3E"><input id="second" autofocus>'},
  {id:'same-frame',body:'<iframe id="nested" src="/child"></iframe>'},
  {id:'cross-frame',body:'<iframe id="nested" src="'+cross+'/child"></iframe>'},
  {id:'root-first',body:'<input id="first" autofocus><iframe id="nested" src="/child"></iframe>'},
  {id:'child-first',body:'<iframe id="nested" src="/ordered-child"></iframe>'},
  {id:'sandbox',body:'<iframe id="nested" sandbox="allow-same-origin" src="/child"></iframe>'},
  {id:'sandbox-scripts',body:'<iframe id="nested" sandbox="allow-scripts allow-same-origin" src="/child"></iframe>'},
  {id:'sandbox-grant',body:'<iframe id="nested" sandbox="allow-scripts allow-same-origin" allow="focus-without-user-activation *" src="/child"></iframe>'},
  {id:'sandbox-no-scripts-grant',body:'<iframe id="nested" sandbox="allow-same-origin" allow="focus-without-user-activation *" src="/child"></iframe>'},
  {id:'sandbox-inherited',body:'<iframe id="nested" sandbox="allow-same-origin" allow="focus-without-user-activation *" src="/nested-child"></iframe>'},
  {id:'child-fragment',body:'<iframe id="nested" src="/fragment-child#anchor"></iframe>'},
  {id:'srcdoc',body:'<iframe id="nested" srcdoc="<input id=inside autofocus>"></iframe>'},
  {id:'frame-element',body:'<iframe id="nested" autofocus src="/empty"></iframe><input id="second" autofocus>'},
  {id:'inert-template',body:'<template><input id="inert" autofocus></template><input id="first" autofocus>'},
  {id:'dialog',body:'<dialog id="dialog"><input id="inside" autofocus></dialog><input id="outside" autofocus><script>document.getElementById("dialog").showModal()</script>'},
  {id:'popover',body:'<div id="popover" popover><input id="inside" autofocus></div><input id="outside" autofocus><script>document.getElementById("popover").showPopover()</script>'},
  {id:'after-canvas-click',click:true,body:'<canvas id="pad" width="100" height="50"></canvas><script>document.getElementById("pad").addEventListener("pointerdown",event=>{event.preventDefault();setTimeout(()=>{const input=document.createElement("input");input.id="first";input.autofocus=true;document.body.append(input);},20)});</script>'},
  {id:'named-input-fragment',hash:'#q',body:'<input id="first" name="q" autofocus>'},
  {id:'named-anchor-fragment',hash:'#q',body:'<a name="q">Anchor</a><input id="first" autofocus>'},
  {id:'top-fragment',hash:'#top',body:'<input id="first" autofocus>'},
  {id:'math',body:'<math><mi id="first" autofocus tabindex="0">x</mi></math><input id="second" autofocus>'}
];
const html=test=>'<!doctype html><head>'+(test.head||'')+'</head><body><script>globalThis.autofocusEvents=[];addEventListener("focusin",event=>autofocusEvents.push(event.target.id));</script>'+test.body;
const snapshot='({active:document.activeElement.id,tag:document.activeElement.tagName,events:autofocusEvents,child:document.getElementById("nested")?.contentDocument?.activeElement?.id,focusCalls:globalThis.focusCalls,attributes:Array.from(document.querySelectorAll("[autofocus]"),field=>({id:field.id,value:field.getAttribute("autofocus"),property:field.autofocus}))})';

export async function verifyAutofocus(page,{batch=0,batches=1,expectDiagnostics=()=>{}}={}){
  const selected=scenarios.filter((_,index)=>index%batches===batch),native=await page.context().newPage(),errors=[],direct=[],onError=error=>errors.push(error.message),onRequest=request=>{if(/^https?:/.test(request.url()))direct.push(request.url());};
  const serve=async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/hide.css'){await new Promise(resolve=>setTimeout(resolve,60));return route.fulfill({contentType:'text/css',body:'#first{display:none}'});}
    return route.fulfill({contentType:'text/html',body:children[path]||html(scenarios.find(test=>'/'+test.id===path))});
  };
  await native.route(origin+'/**',serve);await native.route(cross+'/**',serve);
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const read=async(proxy,source)=>JSON.parse(await evaluate(proxy,'JSON.stringify('+source+')'));
  try{
    expectDiagnostics(diagnostics);
    await page.evaluate(({origin,cross,documents,children})=>{
      globalThis.autofocusPrevious=sandstone.network.session.fetch;
      sandstone.network.session.fetch=async(url,options)=>{
        if(![origin,cross].includes(new URL(url).origin))return autofocusPrevious(url,options);
        const path=new URL(url).pathname;if(path==='/hide.css'){await new Promise(resolve=>setTimeout(resolve,60));return new Response('#first{display:none}',{headers:{'content-type':'text/css'}});}
        return new Response(children[path]||documents[path],{headers:{'content-type':'text/html'}});
      };
    },{origin,cross,children,documents:Object.fromEntries(scenarios.map(test=>['/'+test.id,html(test)]))});
    page.on('pageerror',onError);page.on('request',onRequest);
    for(const test of selected){
      const url=origin+'/'+test.id+(test.hash||'');
      await native.bringToFront();await native.goto(url);if(test.click)await native.locator('#pad').click();await native.waitForTimeout(150);const expected=await read(false,snapshot);
      if(test.id==='initial')assert.equal(expected.active,'first');
      await page.bringToFront();await page.evaluate(url=>main_frame.navigate_to(url),url);if(test.click)await page.frameLocator('iframe[frame-id]').locator('#pad').click();await page.waitForTimeout(150);
      assert.deepEqual(await read(true,snapshot),expected,'Autofocus differs: '+test.id);
      if(test.id==='initial'){
        await native.bringToFront();await native.keyboard.type('native input');
        await page.bringToFront();await page.keyboard.type('native input');
        assert.equal(await read(true,'document.getElementById("first").value'),await read(false,'document.getElementById("first").value'));
        const reopen='document.open();document.write("<input id=reopened autofocus>");document.close();true';
        await evaluate(false,reopen);await native.waitForTimeout(100);const reopened=await read(false,'document.activeElement.id');
        await evaluate(true,reopen);await page.waitForTimeout(100);assert.equal(await read(true,'document.activeElement.id'),reopened,'document.open reset a processed autofocus flag');
      }
    }
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);return selected.map(test=>'Native HTML autofocus: '+test.id);
  }finally{page.off('pageerror',onError);page.off('request',onRequest);await page.evaluate(()=>{if(globalThis.autofocusPrevious){sandstone.network.session.fetch=autofocusPrevious;delete globalThis.autofocusPrevious;}});await native.close();await page.bringToFront();}
}

export async function verifyAutofocusWithoutScripts(page,expectDiagnostics=()=>{}){
  const context=await page.context().browser().newContext({javaScriptEnabled:false}),native=await context.newPage();
  const html='<!doctype html><input id="first" autofocus onfocus="globalThis.authorFocusRan=true"><script>globalThis.authorScriptRan=true</script>';
  await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:html}));
  try{
    expectDiagnostics(diagnostics);
    await native.goto(origin+'/no-scripts');await native.waitForTimeout(150);
    const expected=await native.evaluate(()=>({active:document.activeElement.id,ran:!!globalThis.authorScriptRan,focusRan:!!globalThis.authorFocusRan}));assert.deepEqual(expected,{active:'first',ran:false,focusRan:false});
    await page.evaluate(html=>{globalThis.noScriptAutofocus={fetch:sandstone.network.session.fetch,allow:main_frame.default_settings.allow_js};sandstone.network.session.fetch=async()=>new Response(html,{headers:{'content-type':'text/html'}});main_frame.default_settings.allow_js=false;},html);
    await page.bringToFront();await page.evaluate(url=>main_frame.navigate_to(url),origin+'/no-scripts');await page.waitForTimeout(150);
    const actual=JSON.parse(await page.evaluate(()=>main_frame.eval_js('JSON.stringify({active:document.activeElement.id,ran:!!globalThis.authorScriptRan,focusRan:!!globalThis.authorFocusRan})')));assert.deepEqual(actual,expected);
    return ['HTML autofocus remains available when author JavaScript is disabled'];
  }finally{await page.evaluate(()=>{if(globalThis.noScriptAutofocus){sandstone.network.session.fetch=noScriptAutofocus.fetch;main_frame.default_settings.allow_js=noScriptAutofocus.allow;delete globalThis.noScriptAutofocus;}});await context.close();await page.bringToFront();}
}
