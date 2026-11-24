import assert from 'node:assert/strict';

export async function verifyGlobalMethodInstrumentation(page){
  const context=await page.context().browser().newContext();
  const url='https://method-instrumentation.test/',native=await context.newPage(),fixture=await context.newPage(),direct=[];
  const html='<!doctype html><title>Method instrumentation</title>';
  const source=`(()=>{
    const prototype=EventTarget.prototype,original=Object.getOwnPropertyDescriptor(prototype,'addEventListener');
    const saved=window.addEventListener,initialSame=saved===prototype.addEventListener,receivers=[],listeners=new WeakMap([[window,[]]]);
    const replacement=new Proxy(original.value,{apply(target,receiver,args){
      receivers.push(receiver===window?'window':receiver===other?'other':'unexpected');
      listeners.get(receiver)?.push(args[0]);return Reflect.apply(target,receiver,args);
    }});
    const other=new EventTarget(),events=[],callback=()=>events.push('window');
    try{
      Object.defineProperty(prototype,'addEventListener',{...original,value:replacement});
      const same=window.addEventListener===replacement;
      window.addEventListener('instrumented',callback);
      replacement.call(other,'instrumented',()=>events.push('other'));
      window.dispatchEvent(new Event('instrumented'));other.dispatchEvent(new Event('instrumented'));
      window.removeEventListener('instrumented',callback);window.dispatchEvent(new Event('instrumented'));
      const registered=listeners.get(window).slice();
      Object.defineProperty(prototype,'addEventListener',original);
      const restored=window.addEventListener===saved;
      return JSON.stringify({initialSame,same,restored,receivers,registered,events});
    }finally{Object.defineProperty(prototype,'addEventListener',original);window.removeEventListener('instrumented',callback);}
  })()`;
  try{
    await native.route(url+'**',route=>route.fulfill({contentType:'text/html',body:html}));await native.goto(url);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});await fixture.goto(page.url());
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.evaluate(async({url,html})=>{sandstone.network.session.fetch=async()=>new Response(html,{headers:{'content-type':'text/html'}});await main_frame.navigate_to(url);},{url,html});
    const expected=JSON.parse(await native.evaluate(source=>eval(source),source));
    const actual=JSON.parse(await fixture.evaluate(source=>main_frame.eval_js(source),source));
    assert.deepEqual(actual,expected);assert.equal(actual.initialSame,true);assert.equal(actual.same,true);assert.equal(actual.restored,true);
    assert.deepEqual(actual.receivers,['window','other']);assert.deepEqual(actual.registered,['instrumented']);assert.deepEqual(actual.events,['window','other']);
    assert.deepEqual(direct,[]);
    return ['Prototype method instrumentation preserves replacement identity, virtual Window receivers, borrowed EventTargets and listener removal'];
  }finally{await context.close();}
}
