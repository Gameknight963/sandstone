import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const font=await readFile(new URL('./fonts/fixture.ttf',import.meta.url));
const origin='https://url-surfaces.test',encodings=['windows-1251','Shift_JIS','windows-1252','UTF-8'];
const query='?q=Тест&japanese=日本',escaped=String.raw`?q=\0422\0435\0441\0442&japanese=\65e5\672c`;
const html='<!doctype html><base href="/assets/base/"><link rel="stylesheet" href="/sheet.css"><style id="inline">.inline{background-image:url("/inline'+escaped+'")}</style><div class="external">External</div><div class="child">Child</div><div class="inline">Inline</div><div style="background-image:url(/initial'+escaped+')">Initial</div><main id="mount"></main>';
const sheet='@import "/child.css'+escaped+'";@font-face{font-family:SheetFont;src:url("/sheet-font.ttf'+escaped+'")}.external{font-family:SheetFont;background-image:url("/external'+escaped+'")}';
const child='.child{background-image:url("/child-image'+escaped+'")}' ;
const paths=['/inline','/initial','/external','/child.css','/child-image','/sheet-font.ttf','/constructor-font.ttf','/cssom','/ruleproperty','/property','/attribute','/fragment','/constructed'];
function content(url,encoding){
  const path=new URL(url).pathname;
  if(path==='/sheet.css')return {body:[...Buffer.from(sheet)],type:'text/css;charset=windows-1251'};
  if(path==='/child.css')return {body:[...Buffer.from(child)],type:'text/css;charset=Shift_JIS'};
  if(path.endsWith('.ttf'))return {body:[...font],type:'font/ttf'};
  if(paths.includes(path))return {body:[...Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')],type:'image/svg+xml'};
  return {body:[...Buffer.from(html)],type:'text/html;charset='+encoding};
}
async function exercise(query){
  const add=name=>{const node=document.createElement('div');node.className=name;node.textContent=name;document.getElementById('mount').append(node);return node;};
  const sheet=document.getElementById('inline').sheet;
  sheet.insertRule('.cssom{background-image:url("/cssom'+query+'")}',0);add('cssom');
  sheet.insertRule('.ruleproperty{}',0);sheet.cssRules[0].style.backgroundImage='url("/ruleproperty'+query+'")';add('ruleproperty');
  add('property').style.backgroundImage='url("/property'+query+'")';
  add('attribute').setAttribute('style','background-image:url("/attribute'+query+'")');
  add('fragment').innerHTML='<div style=\'background-image:url("/fragment'+query+'")\'>Fragment</div>';
  const constructed=new CSSStyleSheet();constructed.replaceSync('.constructed{background-image:url("/constructed'+query+'") }');document.adoptedStyleSheets=[constructed];add('constructed');
  for(const node of document.querySelectorAll('div'))getComputedStyle(node).backgroundImage;
  const face=new FontFace('ConstructorFont','url("/constructor-font.ttf'+query+'")');await face.load();document.fonts.add(face);
  await document.fonts.load('20px SheetFont','AAA');
  return true;
}

export async function verifyURLSurfaces(page,{batch=0,batches=1}={}){
  const native=await page.context().newPage(),requests=[],direct=[],passed=[];let currentEncoding='UTF-8';
  await native.route('**/*',route=>{const response=content(route.request().url(),currentEncoding);requests.push(route.request().url());return route.fulfill({body:Buffer.from(response.body),contentType:response.type,headers:{'Cache-Control':'no-store'}});});
  const onRequest=request=>{if(/^https?:/.test(request.url()))direct.push(request.url());};page.on('request',onRequest);
  const responses=Object.fromEntries(['/sheet.css',...paths].map(path=>[path,content(origin+path,'UTF-8')]));
  await page.evaluate(({responses,html})=>{
    globalThis.urlSurfaces={previous:sandstone.network.session.fetch,encoding:'UTF-8',requests:[]};
    sandstone.network.session.fetch=async url=>{
      urlSurfaces.requests.push(url);
      const response=responses[new URL(url).pathname];
      const result=new Response(response?new Uint8Array(response.body):html,{headers:{'Content-Type':response?.type||'text/html;charset='+urlSurfaces.encoding,'Cache-Control':'no-store'}});
      Object.defineProperty(result,'url',{value:url});return result;
    };
  },{responses,html});
  try{
    for(const encoding of encodings.filter((_,index)=>index%batches===batch)){
      currentEncoding=encoding;await page.evaluate(encoding=>{urlSurfaces.encoding=encoding;urlSurfaces.requests=[];},encoding);requests.length=0;
      const start=origin+'/page/'+encodeURIComponent(encoding);
      await native.goto(start);await native.evaluate(exercise,query);
      await page.evaluate(start=>main_frame.navigate_to(start),start);
      await page.evaluate(source=>main_frame.eval_js(source),'('+exercise.toString()+')('+JSON.stringify(query)+')');
      await page.waitForFunction(paths=>paths.every(path=>urlSurfaces.requests.some(url=>new URL(url).pathname===path)),paths);
      const filter=values=>values.filter(url=>paths.includes(new URL(url).pathname)).sort();
      assert.deepEqual(filter(await page.evaluate(()=>urlSurfaces.requests)),filter(requests),'CSS request encodings: '+encoding);
      passed.push('Stylesheets, imports, rules, inline attributes, constructed sheets and FontFace retain native '+encoding+' URL encodings');
      for(const mode of ['assign','replace','href','search']){
        await native.goto(start);await page.evaluate(start=>main_frame.navigate_to(start),start);
        await native.evaluate(({mode,query})=>{if(mode==='assign'||mode==='replace')location[mode](query);else location[mode]=query;},{mode,query});
        await native.waitForURL(url=>url.search.startsWith('?q='));
        const expected=native.url(),navigation=await page.evaluate(()=>main_frame.navigation_id);
        await page.evaluate(source=>main_frame.eval_js(source),mode==='assign'||mode==='replace'?'location.'+mode+'('+JSON.stringify(query)+');true':'location.'+mode+'='+JSON.stringify(query)+';true');
        await page.waitForFunction(navigation=>main_frame.navigation_id>navigation&&!main_frame.is_navigating,navigation);
        assert.equal(await page.evaluate(()=>main_frame.url.href),expected,mode+' navigation: '+encoding);
      }
      passed.push('Location assign, replace and href honor document base/encoding while search setters remain UTF-8 on '+encoding+' pages');
      await native.goto(start);await page.evaluate(start=>main_frame.navigate_to(start),start);
      const coercion=`(()=>{document.querySelector('base').remove();globalThis.conversions=0;location.assign({toString(){globalThis.conversions++;return '#';}});return JSON.stringify({conversions,href:location.href});})()`;
      const expected=await native.evaluate(source=>eval(source),coercion),actual=await page.evaluate(source=>main_frame.eval_js(source),coercion);
      assert.equal(actual,expected,'Location conversion: '+encoding);
      passed.push('Same-document Location navigation converts its URL argument once on '+encoding+' pages');
    }
    assert.deepEqual(direct,[],'CSS and navigation URLs must stay behind the relay');return passed;
  }finally{
    await page.evaluate(()=>{sandstone.network.session.fetch=urlSurfaces.previous;delete globalThis.urlSurfaces;});page.off('request',onRequest);await native.close();
  }
}
