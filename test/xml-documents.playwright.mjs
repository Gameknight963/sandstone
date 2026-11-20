import assert from 'node:assert/strict';

const types=['image/svg+xml','application/xhtml+xml','application/xml','text/xml'];
export async function verifyXMLDocuments(page){
  const fixture=await page.context().newPage(),native=await page.context().newPage();
  const direct=[],errors=[];
  fixture.on('pageerror',error=>errors.push(error.message));
  try{
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    for(const mime of types){
      const script=`globalThis.events=[];events.push(['inline',!!document.getElementById('later'),document.readyState]);document.addEventListener('readystatechange',()=>events.push(['state',document.readyState]));document.addEventListener('DOMContentLoaded',()=>events.push(['dcl',document.readyState]));addEventListener('load',()=>events.push(['window-load',document.readyState]));`;
      const source=mime==='image/svg+xml'?`<?xml version="1.0"?><!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" onload="events.push(['root-load',document.readyState])"><script><![CDATA[${script}]]></script><!--authored comment--><g id="later"><![CDATA[<authored> & text]]></g></svg>`:`<?xml version="1.0"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><script><![CDATA[${script}]]></script></head><!--authored comment--><body id="later"><![CDATA[<authored> & text]]></body></html>`;
      await native.route('https://xml.test/**',route=>route.fulfill({contentType:mime,body:source}));
      await native.goto('https://xml.test/');
      await fixture.evaluate(async({mime,source})=>{
        main_frame.on_load=()=>{};
        sandstone.network.session.fetch=async()=>new Response(source,{headers:{'content-type':mime}});
        await main_frame.navigate_to('https://xml.test/');
      },{mime,source});
      const code='JSON.stringify({events,xml:document instanceof XMLDocument,root:document.documentElement.nodeName,namespace:document.documentElement.namespaceURI,doctype:document.doctype?.name,cdata:[...document.getElementById("later").childNodes].map(node=>[node.nodeType,node.nodeValue]),body:document.body?.nodeName,compat:document.compatMode,type:document.contentType,origin:origin})';
      const expected=JSON.parse(await native.evaluate(code=>eval(code),code));
      const actual=JSON.parse(await fixture.evaluate(code=>main_frame.eval_js(code),code));
      assert.deepEqual(actual,expected,mime+' native parser state and lifecycle');
      await native.unrouteAll();
    }
    for(const mime of ['image/svg+xml','application/xhtml+xml']){
      const svg=mime==='image/svg+xml';
      const source=svg?`<svg xmlns="http://www.w3.org/2000/svg"><style>@import './base.css';</style><script href="./classic.js"/><rect id="sample" width="10" height="10"/></svg>`:`<html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" href="./base.css"/><script src="./classic.js"></script></head><body><div id="sample">Sample</div></body></html>`;
      const resources={
        '/document':{body:source,type:mime},
        '/classic.js':{body:'globalThis.classicValue=41;globalThis.dataValue=fetch("./data").then(response=>response.text());globalThis.moduleReady=new Promise((resolve,reject)=>{const script=document.createElementNS("http://www.w3.org/1999/xhtml","script");script.type="module";script.src="./module-entry.js";script.onload=resolve;script.onerror=reject;document.documentElement.append(script);});',type:'text/javascript'},
        '/module-entry.js':{body:'import {value} from "./module.js";globalThis.moduleValue=value;',type:'text/javascript'},
        '/module.js':{body:'export const value=42;',type:'text/javascript'},
        '/base.css':{body:'#sample {color:rgb(12,34,56);fill:rgb(12,34,56)}',type:'text/css'},
        '/data':{body:'relayed XML data',type:'text/plain'}
      };
      await native.route('https://xml.test/**',route=>{
        const resource=resources[new URL(route.request().url()).pathname];
        return route.fulfill({status:resource?200:404,contentType:resource?.type||'text/plain',body:resource?.body||''});
      });
      await native.goto('https://xml.test/document');
      await native.waitForFunction(()=>globalThis.moduleValue===42);
      await fixture.evaluate(async resources=>{
        sandstone.network.session.fetch=async input=>{
          const url=typeof input==='string'?input:input.url,resource=resources[new URL(url).pathname];
          const response=new Response(resource?.body||'',{status:resource?200:404,headers:{'content-type':resource?.type||'text/plain'}});
          Object.defineProperty(response,'url',{value:url});return response;
        };
        await main_frame.navigate_to('https://xml.test/document');
      },resources);
      const code=`(async()=>{await moduleReady;return JSON.stringify({classic:classicValue,module:moduleValue,data:await dataValue,color:getComputedStyle(document.getElementById('sample')).color,fill:getComputedStyle(document.getElementById('sample')).fill});})()`;
      const expected=JSON.parse(await native.evaluate(code=>eval(code),code));
      const actual=JSON.parse(await fixture.evaluate(code=>main_frame.eval_js(code),code));
      assert.deepEqual(actual,expected,mime+' scripts, modules, styles and fetch');
      await native.unrouteAll();
    }
    assert.deepEqual(errors,[],'XML documents raised script errors');
    assert.deepEqual(direct,[],'XML documents made direct HTTP requests');
  }finally{await native.close();await fixture.close();}
  return ['Native SVG/XHTML/XML document identity, namespaces and parser script visibility','XML document lifecycle and SVG root load handlers match native navigation','SVG/XHTML classic scripts, modules, stylesheets and fetch stay behind the relay'];
}
