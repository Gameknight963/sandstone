import assert from 'node:assert/strict';
import {wait_for} from './wait-for.mjs';

export async function verifyFragmentFallbacks(page){
  const origin='https://fragment-fallback.test',url=origin+'/page';
  const html=base=>'<!doctype html><title>Fragments</title>'+(base?'<base href="https://other.test/assets/">':'')+'<style>:target{outline:3px solid red}</style><body><input id="start"><input id="field"><input id="next"><script>globalThis.marker={};globalThis.events=[];for(const type of ["popstate","hashchange","focusin","focusout"])addEventListener(type,e=>events.push({type,id:e.target.id||null}));</script>';
  const results=[];
  for(const mode of ['base','legacy']){
    const native=await page.context().newPage(),fixture=await page.context().newPage(),errors=[],direct=[];
    try{
      await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:html(mode==='base')}));await native.goto(url);
      if(mode==='legacy')await fixture.addInitScript(()=>{Object.defineProperty(window,'navigation',{configurable:true,value:undefined});});
      fixture.on('pageerror',error=>errors.push(error.message));await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
      await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
      await fixture.evaluate(async({url,html})=>{sandstone.network.session.fetch=async()=>new Response(html,{headers:{'content-type':'text/html'}});await main_frame.navigate_to(url);},{url,html:html(mode==='base')});
      const evaluate=(proxy,source)=>proxy?fixture.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
      const values=[];
      for(const proxy of [false,true]){
        await evaluate(proxy,'globalThis.savedMarker=marker;globalThis.beforeHistory=history.length;document.getElementById("start").focus();events=[];location.hash="field";true');
        await wait_for(()=>evaluate(proxy,'events.some(event=>event.type==="hashchange")'));
        values.push(JSON.parse(await evaluate(proxy,'JSON.stringify({url:location.href,active:document.activeElement.id,target:document.querySelector(":target")?.id,outline:getComputedStyle(document.getElementById("field")).outlineWidth,events,same:marker===savedMarker,history:history.length-beforeHistory})')));
      }
      assert.deepEqual(values[1],values[0],mode);assert.equal(values[1].target,'field');assert.equal(values[1].same,true);assert.equal(values[1].history,1);assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
      results.push(mode==='base'?'Fragments with authored base URLs stay in the document and preserve native focus, target styles and virtual history':'Fragments remain functional without the native Navigation API');
    }finally{await native.close();await fixture.close();}
  }
  return results;
}
