import assert from 'node:assert/strict';

async function attach({url,source,mime,sandboxed,blob}){
  const frame=document.createElement('iframe');
  if(sandboxed)frame.sandbox='allow-scripts';
  if(blob)url=URL.createObjectURL(new Blob([source],{type:mime}));frame.src=url;
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{removeEventListener('message',receive);reject(new Error('XML iframe did not reply'));},4000);
    const receive=event=>{if(event.source!==frame.contentWindow||!event.data?.xmlChild)return;clearTimeout(timer);removeEventListener('message',receive);resolve({origin:event.origin,source:event.source===frame.contentWindow,result:event.data.xmlChild});};
    addEventListener('message',receive);document.body.append(frame);
  });
  try{frame.contentWindow.document;result.access='allowed';}catch(error){result.access=error.name;}
  frame.remove();if(blob)URL.revokeObjectURL(url);return result;
}
export async function verifyXMLIframes(page,{sandboxed=false}={}){
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage(),fixture=await page.context().newPage(),direct=[],errors=[];
  fixture.on('pageerror',error=>errors.push(error.message));
  try{
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    for(const mime of ['image/svg+xml','application/xhtml+xml','application/xml','text/xml','application/rss+xml','application/atom+xml'])for(const mode of sandboxed?['sandbox','blob']:['data','cross']){
      const script=`(async()=>{const result={type:document.contentType,xml:document instanceof XMLDocument,origin:origin,locationOrigin:location.origin,protocol:location.protocol,referrer:document.referrer,color:getComputedStyle(document.documentElement).color,rtc:typeof RTCPeerConnection};try{localStorage.setItem('xml-child','saved');result.storage=localStorage.getItem('xml-child');}catch(error){result.storage=error.name;}try{result.value=await(await fetch('https://xml-child.test/value')).text();}catch(error){result.value=error.name;}parent.postMessage({xmlChild:result},'*');})()`;
      const children='<link xmlns="http://www.w3.org/1999/xhtml" rel="stylesheet" href="https://xml-child.test/style.css"/><script xmlns="http://www.w3.org/1999/xhtml"><![CDATA['+script+']]></script>';
      const source=mime==='image/svg+xml'?'<svg xmlns="http://www.w3.org/2000/svg">'+children+'</svg>':'<html xmlns="http://www.w3.org/1999/xhtml"><head>'+children+'</head><body/></html>';
      const parent='<!doctype html><body>XML frames',css=':root{color:rgb(17,39,61)}';
      const resources={'https://xml-parent.test/':{body:parent,type:'text/html'},'https://xml-parent.test/child':{body:source,type:mime},'https://xml-child.test/document':{body:source,type:mime},'https://xml-child.test/style.css':{body:css,type:'text/css'},'https://xml-child.test/value':{body:'relayed XML child',type:'text/plain'}};
      await native.route(/^https?:/,route=>{const resource=resources[route.request().url()];return route.fulfill({status:resource?200:404,contentType:resource?.type||'text/plain',headers:{'access-control-allow-origin':'*'},body:resource?.body||''});});
      await native.goto('https://xml-parent.test/');
      const url=mode==='data'?'data:'+mime+';charset=utf-8,'+encodeURIComponent(source):mode==='sandbox'?'https://xml-parent.test/child':'https://xml-child.test/document';
      const options={url,source,mime,sandboxed,blob:mode==='blob'};
      const expected=await native.evaluate(attach,options);expected.result.rtc='undefined';
      assert.equal(expected.result.value,'relayed XML child');assert.equal(expected.result.color,'rgb(17, 39, 61)');assert.equal(expected.result.xml,true);
      await fixture.evaluate(async resources=>{
        sandstone.network.session.fetch=async input=>{const url=typeof input==='string'?input:input.url,resource=resources[url];return new Response(resource?.body||'',{status:resource?200:404,headers:{'content-type':resource?.type||'text/plain','access-control-allow-origin':'*'}});};
        main_frame.on_load=()=>{};await main_frame.navigate_to('https://xml-parent.test/');
      },resources);
      const actual=JSON.parse(await fixture.evaluate(({source,options})=>main_frame.eval_js('('+source+')('+JSON.stringify(options)+').then(JSON.stringify)'),{source:attach.toString(),options}));
      assert.deepEqual(actual,expected,mime+' '+mode+' iframe semantics');
      await native.unrouteAll();
    }
    assert.deepEqual(errors,[],'XML iframe scripts raised errors');assert.deepEqual(direct,[],'XML iframe resources bypassed the relay');
  }finally{await nativeContext.close();await fixture.close();}
  return sandboxed?['Sandboxed HTTP and Blob XML iframes preserve opaque origins and storage restrictions','Sandboxed XML iframe scripts, stylesheets and API requests stay behind the relay']:['Opaque data and cross-origin XML iframes preserve native MIME, document identity and origin boundaries','XML iframe scripts, stylesheets, storage and API requests remain behind the relay'];
}
