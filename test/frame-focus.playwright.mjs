import assert from 'node:assert/strict';

const origin='https://frame-focus.test';
const child='<!doctype html><body><canvas id="pad" width="160" height="80"></canvas><input id="text"><script>globalThis.focusKeys=[];for(const type of ["pointerdown","mousedown"])document.getElementById("pad").addEventListener(type,event=>event.preventDefault());addEventListener("keydown",event=>focusKeys.push([event.key,event.ctrlKey]));</script>';
const html=child+'<iframe id="nested" src="/child"></iframe>';
export async function verifyFrameFocus(page){
  const native=await page.context().newPage(),passed=[];
  await native.route(origin+'/**',route=>route.fulfill({body:new URL(route.request().url()).pathname==='/child'?child:html,contentType:'text/html;charset=utf-8'}));
  await page.evaluate(({origin,html,child})=>{
    globalThis.frameFocusTest={previous:sandstone.network.session.fetch};
    sandstone.network.session.fetch=async(url,options)=>{
      if(new URL(url).origin!==origin)return frameFocusTest.previous(url,options);
      const result=new Response(new URL(url).pathname==='/child'?child:html,{headers:{'Content-Type':'text/html;charset=utf-8'}});Object.defineProperty(result,'url',{value:url});return result;
    };
  },{origin,html,child});
  const read=source=>page.evaluate(source=>main_frame.eval_js(source),source);
  const surface=page.frameLocator('iframe[frame-id]');
  const hostFocus=async()=>{await page.bringToFront();await page.locator('input').first().focus();assert.equal(await read('document.hasFocus()'),false);};
  try{
    await native.goto(origin+'/start');await native.locator('#pad').click();await native.keyboard.press('Control+z');
    const expected=await native.evaluate(()=>({keys:focusKeys,focused:document.hasFocus()}));
    await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');await hostFocus();
    await surface.locator('#pad').click();await page.keyboard.press('Control+z');
    assert.deepEqual(JSON.parse(await read('JSON.stringify({keys:focusKeys,focused:document.hasFocus()})')),expected);
    passed.push('Trusted pointer interaction focuses a virtual top-level page despite cancelled mouse defaults');
    await hostFocus();await read('document.getElementById("pad").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));true');
    assert.equal(await read('document.hasFocus()'),false);
    assert.equal(await page.evaluate(()=>document.activeElement.tagName),'INPUT');
    passed.push('Synthetic pointer events cannot steal focus from the proxy controls');
    await surface.locator('#text').click();await page.keyboard.insertText('typed');
    assert.equal(await read('document.activeElement.id+":"+document.getElementById("text").value'),'text:typed');
    passed.push('Native input focus and text entry remain intact');
    await native.bringToFront();await native.locator('#text').focus();await native.evaluate(()=>{focusKeys=[];});
    await native.frameLocator('#nested').locator('#pad').click();await native.keyboard.press('Control+z');
    const nestedExpected=await native.evaluate(()=>({parent:focusKeys,child:document.getElementById('nested').contentWindow.focusKeys}));
    await page.bringToFront();await surface.locator('#text').focus();await read('focusKeys=[];true');
    await surface.frameLocator('#nested').locator('#pad').click();await page.keyboard.press('Control+z');
    assert.deepEqual(JSON.parse(await read('JSON.stringify({parent:focusKeys,child:document.getElementById("nested").contentWindow.focusKeys})')),nestedExpected);
    passed.push('Nested frame focus retains native keyboard routing');
    await read('document.open();document.write('+JSON.stringify(html)+');document.close();true');
    await read('globalThis.focusCalls=0;window.focus=()=>focusCalls++;true');await hostFocus();
    await surface.locator('#pad').click();await page.keyboard.press('Control+z');
    assert.deepEqual(JSON.parse(await read('JSON.stringify({keys:focusKeys,focused:document.hasFocus()})')),expected);
    assert.equal(await read('focusCalls'),0);
    passed.push('Runtime focus survives document.open and uses the captured native method');
    return passed;
  }finally{await page.evaluate(()=>{sandstone.network.session.fetch=frameFocusTest.previous;delete globalThis.frameFocusTest;});await native.close();}
}
