import assert from 'node:assert/strict';

const instruction='type="text/css" href="./start.css"';
async function mutate(){
  const pi=[...document.childNodes].find(node=>node.nodeType===7);
  const initial={data:pi.data,nodeValue:pi.nodeValue,textContent:pi.textContent,length:pi.length,substring:pi.substringData(2,11),clone:pi.cloneNode().data,serialized:new XMLSerializer().serializeToString(pi),inline:globalThis.inlineColor,color:getComputedStyle(document.documentElement).color};
  const records=[],observer=new MutationObserver(list=>records.push(...list.map(record=>({type:record.type,oldValue:record.oldValue,target:record.target===pi}))));
  observer.observe(pi,{characterData:true,characterDataOldValue:true});
  const wait=async color=>{for(let n=0;n<200;n++){if(getComputedStyle(document.documentElement).color===color)return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('XML stylesheet color did not change: '+color);};
  pi.data="type='text/css' href='./second.css'";await wait('rgb(70, 80, 90)');
  pi.appendData(' media="all"');await wait('rgb(70, 80, 90)');
  pi.nodeValue='type="text/css" href="./third.css"';await wait('rgb(101, 102, 103)');
  pi.textContent="type='text/css' href='./second.css'";await wait('rgb(70, 80, 90)');
  pi.insertData(pi.length,' media="all"');await wait('rgb(70, 80, 90)');
  pi.replaceData(pi.length-11,11,'');await wait('rgb(70, 80, 90)');
  const changed={data:pi.data,nodeValue:pi.nodeValue,textContent:pi.textContent,length:pi.length,substring:pi.substringData(0,9),clone:pi.cloneNode().data,serialized:new XMLSerializer().serializeToString(pi)};
  try{pi.deleteData(pi.length+1,0);}catch(error){changed.error=error.name;}
  await Promise.resolve();records.push(...observer.takeRecords().map(record=>({type:record.type,oldValue:record.oldValue,target:record.target===pi})));observer.disconnect();
  const copy=document.createProcessingInstruction('xml-stylesheet','type="text/css" href="./third.css"');
  document.insertBefore(copy,document.documentElement);await wait('rgb(101, 102, 103)');
  const inserted={data:copy.data,clone:copy.cloneNode().data,color:getComputedStyle(document.documentElement).color};
  copy.remove();await wait('rgb(70, 80, 90)');
  pi.data='type="text/css" href="./slow.css"';
  pi.data='type="text/css" href="./second.css"';await wait('rgb(70, 80, 90)');
  await new Promise(resolve=>setTimeout(resolve,100));
  const staleColor=getComputedStyle(document.documentElement).color;
  pi.data='type="text/css" href="./missing.css"';
  await new Promise(resolve=>setTimeout(resolve,25));
  const failedColor=getComputedStyle(document.documentElement).color;
  return {initial,changed,records,inserted,staleColor,failedColor};
}
export async function verifyXMLStylesheets(page){
  const fixture=await page.context().newPage(),native=await page.context().newPage(),direct=[],errors=[];
  fixture.on('pageerror',error=>errors.push(error.message));
  try{
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    for(const mime of ['image/svg+xml','application/xhtml+xml']){
      const svg=mime==='image/svg+xml',script="globalThis.inlineColor=getComputedStyle(document.documentElement).color;";
      const source='<?xml version="1.0"?><?xml-stylesheet '+instruction+'?>'+(svg?'<svg xmlns="http://www.w3.org/2000/svg"><script><![CDATA['+script+']]></script></svg>':'<html xmlns="http://www.w3.org/1999/xhtml"><head><script><![CDATA['+script+']]></script></head><body/></html>');
      const resources={
        '/document':{body:source,type:mime},
        '/start.css':{body:'@import "./assets/nested.css";',type:'text/css'},
        '/assets/main.css':{body:'@import "./nested.css";',type:'text/css'},
        '/assets/nested.css':{body:':root{color:rgb(12,34,56)}',type:'text/css'},
        '/second.css':{body:':root{color:rgb(70,80,90)}',type:'text/css'},
        '/third.css':{body:':root{color:rgb(101,102,103)}',type:'text/css'},
        '/slow.css':{body:':root{color:rgb(200,201,202)}',type:'text/css'}
      };
      await native.route('https://pi.test/**',async route=>{
        const path=new URL(route.request().url()).pathname;
        if(path==='/slow.css')await new Promise(resolve=>setTimeout(resolve,50));
        const resource=resources[path];return route.fulfill({status:resource?200:404,contentType:resource?.type||'text/plain',body:resource?.body||''});
      });
      await native.goto('https://pi.test/document');
      const expected=await native.evaluate(mutate);
      assert.equal(expected.initial.inline,'rgb(12, 34, 56)','Native stylesheet blocks parser script');
      await fixture.evaluate(async resources=>{
        sandstone.network.session.fetch=async input=>{
          const url=typeof input==='string'?input:input.url;
          if(new URL(url).pathname==='/start.css')return new Response(null,{status:302,headers:{location:'/assets/main.css'}});
          if(new URL(url).pathname==='/slow.css')await new Promise(resolve=>setTimeout(resolve,50));
          const resource=resources[new URL(url).pathname],response=new Response(resource?.body||'',{status:resource?200:404,headers:{'content-type':resource?.type||'text/plain'}});
          Object.defineProperty(response,'url',{value:url});return response;
        };
        main_frame.on_load=()=>{};await main_frame.navigate_to('https://pi.test/document');
      },resources);
      const actual=JSON.parse(await fixture.evaluate(source=>main_frame.eval_js('('+source+')().then(JSON.stringify)'),mutate.toString()));
      assert.equal(actual.initial.inline,'rgb(12, 34, 56)','Relayed stylesheet blocks parser script: '+JSON.stringify(actual));
      assert.deepEqual(actual,expected,mime+' PI CSS, reflection, cloning and mutation records');
      await native.unrouteAll();
    }
    const unsupported=await fixture.evaluate(async()=>{
      const requests=[],instructions=['type="text/xsl" href="https://unrelayed.test/transform.xsl"','type="text/css" href="#embedded"'];
      const source=instructions.map(data=>'<?xml-stylesheet '+data+'?>').join('')+'<svg xmlns="http://www.w3.org/2000/svg"><css id="embedded">svg{background-image:url(https://unrelayed.test/image)}</css><script><![CDATA[globalThis.safeXML=true;]]></script></svg>';
      sandstone.network.session.fetch=async input=>{
        const url=typeof input==='string'?input:input.url;
        if(url!=='https://pi.test/unsupported')requests.push(url);
        return new Response(url==='https://pi.test/unsupported'?source:'',{status:url==='https://pi.test/unsupported'?200:404,headers:{'content-type':'image/svg+xml'}});
      };
      await main_frame.navigate_to('https://pi.test/unsupported');
      return {requests,result:JSON.parse(await main_frame.eval_js('JSON.stringify({usable:safeXML,instructions:[...document.childNodes].filter(node=>node.nodeType===7).map(node=>node.data)})')),instructions};
    });
    assert.deepEqual(unsupported.requests,[],'Unsupported instructions started a transport');
    assert.deepEqual(unsupported.result,{usable:true,instructions:unsupported.instructions},'Unsupported instructions preserve usable XML and authored values');
    assert.deepEqual(errors,[],'XML stylesheets raised script errors');assert.deepEqual(direct,[],'XML stylesheets bypassed the relay');
  }finally{await native.close();await fixture.close();}
  return ['XML stylesheet instructions relay redirected CSS and imports before parser scripts','XML stylesheet data edits, cloning, serialization and mutation records retain authored values','Failed/stale and unsupported XML stylesheets cannot replace newer styles or start native transports'];
}
