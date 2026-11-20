import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

// XML documents must keep their native parser, namespaces and document class.
// Exercise the bundle there before installing an authored document or RPC host.
export async function verifyXMLRuntimeBootstrap(page){
  const runtime=await readFile(new URL('../dist/sandstone_frame.js',import.meta.url),'utf8');
  const fixture=await page.context().newPage(),errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));
  try{
    await fixture.route('http://xml-runtime.test/bootstrap',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><body>Runtime bootstrap parent'}));
    await fixture.goto('http://xml-runtime.test/bootstrap');
    fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
    for(const type of ['text/html','image/svg+xml','application/xhtml+xml']){
      console.log(JSON.stringify({fixture:'Runtime bootstrap',type}));
      const actual=await fixture.evaluate(async({runtime,type,token})=>{
        const suffix=`;(async()=>{
          const ordered=[];
          await sandstone_frame.script_schedule.ordered_classic(()=>ordered.push('classic'));
          const result={token:${JSON.stringify(token)},type:document.contentType,xml:document instanceof XMLDocument,namespace:document.documentElement.namespaceURI};
          result.ordered=ordered;
          parent.postMessage(result,'*');
        })()`;
        const source=runtime+suffix;
        const script=type==='text/html'?'<script>'+source+'</script>':'<script><![CDATA['+source.replaceAll(']]>',']]]]><![CDATA[>')+']]></script>';
        const markup=type==='image/svg+xml'?'<svg xmlns="http://www.w3.org/2000/svg">'+script+'</svg>':(type==='text/html'?'<!doctype html>':'')+'<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/>'+script+'</head><body></body></html>';
        const url=URL.createObjectURL(new Blob([markup],{type})),frame=document.createElement('iframe');
        let receive,timer;
        try{
          return await new Promise((resolve,reject)=>{
            timer=setTimeout(()=>reject(new Error('Runtime bootstrap timed out: '+type)),7000);
            receive=event=>{
              if(event.source!==frame.contentWindow||event.data?.token!==token)return;
              const {token:ignored,...result}=event.data;
              resolve({...result,sourceMatches:frame.contentWindow.sandstone_frame.loader.runtime_src===source});
            };
            addEventListener('message',receive);frame.src=url;document.body.append(frame);
          });
        }finally{clearTimeout(timer);removeEventListener('message',receive);frame.remove();URL.revokeObjectURL(url);}
      },{runtime,type,token:randomUUID()});
      assert.deepEqual(actual,{type,xml:type!=='text/html',namespace:type==='image/svg+xml'?'http://www.w3.org/2000/svg':'http://www.w3.org/1999/xhtml',ordered:['classic'],sourceMatches:true},type+' runtime initialization, ordered scripts and executable source preservation');
    }
    assert.deepEqual(errors,[],'Runtime bootstrap raised script errors');
    assert.deepEqual(direct,[],'Runtime bootstrap made a direct HTTP request');
    return ['Runtime initializes and executes ordered scripts in native SVG and XHTML documents','Runtime source preserves executable script text across HTML and XML CDATA'];
  }catch(error){throw new Error(error.message+'; script errors: '+JSON.stringify(errors),{cause:error});}
  finally{await fixture.close();}
}
