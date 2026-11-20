import assert from 'node:assert/strict';

async function exercise(){
  const initial=log.slice();
  const initialMapping=await import('xml-test-bare').then(module=>module.value,error=>error.name);
  for(const id of ['inline-module','external-module','map']){
    const node=document.getElementById(id);
    document.documentElement.append(node.cloneNode(true));
    node.remove();document.documentElement.append(node);
    if(id==='external-module')node.setAttribute(node.namespaceURI==='http://www.w3.org/2000/svg'?'href':'src','./changed.js');
    else node.textContent='globalThis.log.push("edited");';
    node.setAttribute('type','text/javascript');node.textContent='globalThis.log.push("changed-type");';
  }
  const afterChanges=log.slice();
  await new Promise((resolve,reject)=>{
    const script=document.createElementNS('http://www.w3.org/1999/xhtml','script');script.type='module';
    script.textContent='globalThis.dynamicValue=77;globalThis.mappingResult=await import("xml-test-bare").then(module=>module.value,error=>error.name);';
    let attempts=0;const timer=setInterval(()=>{if(globalThis.mappingResult!==undefined){clearInterval(timer);resolve();}else if(++attempts>300){clearInterval(timer);reject(new Error('Dynamic XML module did not finish'));}},5);
    script.onerror=()=>{clearInterval(timer);reject(new Error('Dynamic XML module failed'));};
    document.documentElement.append(script);
  });
  return {initial,initialMapping,afterChanges,log:log.slice(),dynamic:dynamicValue,mapping:mappingResult,xml:document instanceof XMLDocument};
}
export async function verifyXMLParserScripts(page){
  const fixture=await page.context().newPage(),native=await page.context().newPage(),direct=[],errors=[];
  fixture.on('pageerror',error=>errors.push(error.message));
  try{
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    for(const mime of ['image/svg+xml','application/xhtml+xml','application/xml','text/xml']){
      const svg=mime==='image/svg+xml';
      const scripts='<script><![CDATA[globalThis.log=[];]]></script><script id="inline-module" type="module"><![CDATA[log.push("initial-inline");]]></script><script id="external-module" type="module" '+(svg?'href':'src')+'="./initial.js" onload="log.push(\'initial-load\')"></script><script xmlns="http://www.w3.org/1999/xhtml" id="map" type="importmap"><![CDATA[{"imports":{"xml-test-bare":"./mapped.js"}}]]></script>';
      const source=svg?'<svg xmlns="http://www.w3.org/2000/svg">'+scripts+'</svg>':'<html xmlns="http://www.w3.org/1999/xhtml"><head>'+scripts+'</head><body/></html>';
      const resources={'/document':{body:source,type:mime},'/initial.js':{body:'log.push("initial-external");',type:'text/javascript'},'/changed.js':{body:'log.push("changed-external");',type:'text/javascript'},'/mapped.js':{body:'export const value=66;',type:'text/javascript'}};
      await native.route('https://xml-parser.test/**',route=>{const resource=resources[new URL(route.request().url()).pathname];return route.fulfill({status:resource?200:404,contentType:resource?.type||'text/plain',body:resource?.body||''});});
      await native.goto('https://xml-parser.test/document');
      const expected=await native.evaluate(exercise);
      assert.deepEqual(expected,{initial:[],initialMapping:66,afterChanges:[],log:[],dynamic:77,mapping:66,xml:true},mime+' native parser and dynamic module behavior');
      await fixture.evaluate(async resources=>{
        sandstone.network.session.fetch=async input=>{const url=typeof input==='string'?input:input.url,resource=resources[new URL(url).pathname];return new Response(resource?.body||'',{status:resource?200:404,headers:{'content-type':resource?.type||'text/plain'}});};
        main_frame.on_load=()=>{};await main_frame.navigate_to('https://xml-parser.test/document');
      },resources);
      const actual=JSON.parse(await fixture.evaluate(source=>main_frame.eval_js('('+source+')().then(JSON.stringify)'),exercise.toString()));
      assert.deepEqual(actual,expected,mime+' parser-created module state');
      await native.unrouteAll();
    }
    assert.deepEqual(errors,[],'XML parser scripts raised errors');assert.deepEqual(direct,[],'XML scripts bypassed the relay');
  }finally{await native.close();await fixture.close();}
  return ['XML parser-created modules remain inactive through cloning, reinsertion and edits','XML import maps resolve dynamic imports and dynamically inserted modules'];
}
