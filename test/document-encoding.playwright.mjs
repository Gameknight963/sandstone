import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {createSinglebyteEncoder} from '@exodus/bytes/single-byte.js';
import {createMultibyteEncoder} from '@exodus/bytes/multi-byte.js';

const origin='https://document-encoding.test';
const encode=(source,encoding)=>encoding==='UTF-8'?Buffer.from(source):encoding==='UTF-16LE'?Buffer.from(source,'utf16le'):
  Buffer.from((['windows-1252','windows-1251'].includes(encoding)?createSinglebyteEncoder:createMultibyteEncoder)(encoding)(source));
const inspect='JSON.stringify({text:document.getElementById("text")?.textContent??null,encoding:document.characterSet,aliases:[document.charset,document.inputEncoding],script:window.observed??null,clone:document.cloneNode().characterSet,borrowed:Object.getOwnPropertyDescriptor(Document.prototype,"characterSet").get.call(document),parsed:new DOMParser().parseFromString("<p>parsed</p>","text/html").characterSet})';

export async function verifyDocumentEncoding(page){
  const native=await page.context().newPage(),resources={},direct=[];
  const cases=[
    {name:'HTTP legacy alias overrides meta',encoding:'windows-1252',charset:'ISO-8859-1',meta:'<meta charset=utf-8>',text:'caf\u00e9 \u20ac'},
    {name:'quoted HTTP parameter contains a fake charset',encoding:'shift_jis',contentType:'text/html; note="ignore; charset=windows-1251"; charset=Shift_JIS',text:'\u65e5\u672c'},
    {name:'empty HTTP charset precedes a valid declaration',encoding:'windows-1251',contentType:'text/html; charset=; charset=windows-1251',text:'\u0422\u0435\u0441\u0442'},
    {name:'HTTP charset quoted through end of value',encoding:'windows-1251',contentType:'text/html; charset="windows-1251',text:'\u0422\u0435\u0441\u0442'},
    {name:'meta charset',encoding:'windows-1251',meta:'<meta charset=windows-1251>',text:'\u0422\u0435\u0441\u0442'},
    {name:'Japanese HTTP charset',encoding:'shift_jis',charset:'Shift_JIS',text:'\u65e5\u672c'},
    {name:'Chinese pragma',encoding:'gbk',meta:'<meta http-equiv="Content-Type" content="text/html; charset=gb2312">',text:'\u4e2d\u6587'},
    {name:'Traditional Chinese meta',encoding:'big5',meta:'<meta charset=big5>',text:'\u4e2d\u6587'},
    {name:'UTF-8 BOM overrides HTTP',encoding:'UTF-8',charset:'windows-1251',bom:[0xef,0xbb,0xbf],text:'\u96ea'},
    {name:'UTF-16 BOM overrides declarations',encoding:'UTF-16LE',charset:'windows-1251',bom:[0xff,0xfe],meta:'<meta charset=utf-8>',text:'\u96ea'},
    {name:'undeclared Western fallback',encoding:'windows-1252',text:'caf\u00e9'},
    {name:'undeclared UTF-8 bytes',encoding:'UTF-8',text:'\u96ea'},
    {name:'explicit UTF-8',encoding:'UTF-8',charset:'UTF-8',text:'\u96ea caf\u00e9'}
  ];
  for(const [index,example] of cases.entries()){
    const source='<!doctype html>'+ (example.meta||'')+'<p id="text">'+example.text+'</p><script>window.observed=[document.characterSet,document.charset,document.inputEncoding];</script>';
    resources[origin+'/case-'+index]={bytes:[...(example.bom||[]),...encode(source,example.encoding)],type:example.contentType||'text/html'+(example.charset?';charset='+example.charset:'')};
  }
  const parent='<!doctype html><p id="text">\u65e5\u672c</p><iframe name="blank"></iframe><iframe name="inline" srcdoc="<p id=text>&#38634;</p>"></iframe><iframe name="same" src="/child"></iframe><iframe name="cross" src="https://other-encoding.test/child"></iframe>';
  resources[origin+'/parent']={bytes:[...encode(parent,'shift_jis')],type:'text/html;charset=Shift_JIS'};
  resources[origin+'/child']={bytes:[...encode('<!doctype html><p id="text">\u65e5\u672c</p>','shift_jis')],type:'text/html'};
  resources['https://other-encoding.test/child']={bytes:[...encode('<!doctype html><p id="text">caf\u00e9</p>','windows-1252')],type:'text/html'};
  const resource=(path,source,encoding,type)=>resources[origin+path]={bytes:[...encode(source,encoding)],type};
  resource('/resources','<!doctype html><link rel="stylesheet" href="/legacy.css"><p id="text">\u0422\u0435\u0441\u0442</p><script src="/legacy.js"></script><script src="/japanese.js" charset="Shift_JIS"></script><script src="/invalid.js" charset="unknown"></script><script src="/header.js" charset="windows-1251"></script><script type="module" src="/module.js"></script><script>fetch("/fetch.txt").then(r=>r.text()).then(value=>window.fetchText=value);</script>','windows-1251','text/html;charset=windows-1251');
  resource('/legacy.js','window.legacyClassic="\u0422\u0435\u0441\u0442";','windows-1251','text/javascript');
  resource('/invalid.js','window.invalidCharset="\u0422\u0435\u0441\u0442";','windows-1251','text/javascript');
  resource('/japanese.js','window.japaneseClassic="\u65e5\u672c";','shift_jis','text/javascript');
  resource('/header.js','window.headerClassic="\u96ea";','UTF-8','text/javascript;charset=utf-8');
  resource('/module.js','window.moduleText="\u96ea";','UTF-8','text/javascript;charset=windows-1251');
  resource('/legacy.css','@import "/imported.css";#text{--main:"\u0422\u0435\u0441\u0442"}','windows-1251','text/css');
  resource('/imported.css','@charset "Shift_JIS";@import "/nested.css";#text{--imported:"\u65e5\u672c"}','shift_jis','text/css');
  resource('/nested.css','#text{--nested:"\u65e5\u672c"}','shift_jis','text/css');
  resource('/fetch.txt','\u0422\u0435\u0441\u0442','windows-1251','text/plain;charset=windows-1251');
  const route=/^https:\/\/(?:document-encoding|other-encoding)\.test\//;
  await native.route(route,request=>{
    const resource=resources[request.request().url()];
    return request.fulfill(resource?{contentType:resource.type,body:Buffer.from(resource.bytes)}:{status:204,body:''});
  });
  const block=request=>{direct.push(request.request().url());return request.abort();};
  await page.route(/^https?:/,block);
  try{
    await page.evaluate(resources=>{
      const previous=sandstone.network.session.fetch;
      sandstone.network.session.fetch=(url,options)=>{
        const resource=resources[url];
        if(!resource){if(new URL(url).pathname==='/favicon.ico')return Promise.resolve(new Response(null,{status:204}));return previous(url,options);}
        const response=new Response(Uint8Array.from(resource.bytes),{headers:{'Content-Type':resource.type}});
        Object.defineProperty(response,'url',{value:url});return Promise.resolve(response);
      };
    },resources);
    for(const [index,example] of cases.entries()){
      const url=origin+'/case-'+index;
      await native.goto(url);const expected=await native.evaluate(source=>eval(source),inspect);
      await page.evaluate(url=>main_frame.navigate_to(url),url);
      assert.equal(await page.evaluate(source=>main_frame.eval_js(source),inspect),expected,example.name);
    }
    await native.goto(origin+'/resources');await native.waitForFunction(()=>typeof window.fetchText==='string');
    await page.evaluate(url=>main_frame.navigate_to(url),origin+'/resources');
    await page.waitForFunction(()=>main_frame.eval_js('typeof window.fetchText==="string"'));
    const resourcesInspect='JSON.stringify({classic:window.legacyClassic,japanese:window.japaneseClassic,invalid:window.invalidCharset,header:window.headerClassic,module:window.moduleText,fetch:window.fetchText,css:["--main","--imported","--nested"].map(name=>getComputedStyle(document.getElementById("text")).getPropertyValue(name).trim())})';
    assert.equal(await page.evaluate(source=>main_frame.eval_js(source),resourcesInspect),await native.evaluate(source=>eval(source),resourcesInspect),'Classic script and stylesheet encoding inheritance');
    await native.goto(origin+'/parent');await page.evaluate(url=>main_frame.navigate_to(url),origin+'/parent');
    const root=page.frames().find(frame=>frame.parentFrame()===page.mainFrame());
    for(const name of ['blank','inline','same','cross']){
      const expected=await native.frame({name}).evaluate(source=>eval(source),inspect);
      await page.waitForFunction(name=>Object.values(sandstone.controller.iframes).some(frame=>frame.window_name===name),name);
      const frame=root.childFrames().find(frame=>frame.name()===name);
      assert.ok(frame,'Missing encoded child '+name);
      await frame.waitForFunction(()=>globalThis.sandstone_frame?.context.ctx.document.readyState==='complete');
      assert.equal(await frame.evaluate(source=>sandstone_frame.context.run_script(source),inspect),expected,'Child encoding: '+name);
    }
    assert.deepEqual(direct,[],'Encoded documents bypassed the relay');
    return ['HTML navigation decodes HTTP charset, meta declarations and BOMs before rewriting','Document charset aliases, cloned documents and borrowed getters retain virtual encodings','Classic scripts and stylesheets inherit legacy encoding while modules and Fetch text remain UTF-8','Blank, srcdoc and same/cross-origin iframe encoding follows native inheritance'];
  }finally{await native.close();await page.unroute(/^https?:/,block);}
}
