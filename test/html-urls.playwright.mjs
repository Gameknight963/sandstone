import assert from 'node:assert/strict';
import {wait_for} from './wait-for.mjs';
import {Buffer} from 'node:buffer';

const origin='https://html-urls.test';
const encodings=['UTF-8','windows-1252','windows-1251','Shift_JIS','GBK','Big5','EUC-KR','ISO-2022-JP','GB18030','UTF-16LE'];
const fields=[['a','href','href'],['area','href','href'],['img','src','src'],['script','src','src'],['iframe','src','src'],['link','href','href'],['form','action','action'],['input','formAction','formaction'],['button','formAction','formaction']];
const values=[null,'','?q=Тест','?q=日本&yen=¥&snow=雪','/Тест?q=café&encoded=%D2%zz#雪','#fragment?query=雪',' \0/?q=Т\nест\r \0','?q=\u0000 "<>\'`&x=1','?q=\ud800\udfff','//other.test/path?q=中文','ftp://site.test/?q=é','file:///path?q=Тест','ws://site.test/?q=Тест','wss://site.test/?q=Тест','mailto:user@site.test?q=Тест','custom://site.test/?q=Тест','data:text/plain,?q=雪','http://[','..\\asset?q=Тест'];
const inspect=({fields,values})=>{
  const results=[];
  for(const [tag,key,attribute] of fields)for(const value of values){
    const element=document.createElement(tag);if(value!==null)element.setAttribute(attribute,value);
    results.push([tag,value,element[key],element.getAttribute(attribute)]);
  }
  for(const tag of ['a','area']){
    const element=document.createElement(tag);element.href='/?old=Тест';
    for(const [key,value] of [['hash','雪'],['pathname','/日本'],['search','?next=Тест']]){element[key]=value;results.push([tag,key,element.href,element.getAttribute('href')]);}
  }
  const base=document.createElement('base');base.href='?base=Тест';document.head.append(base);
  const link=document.createElement('a');link.href='#雪';results.push(['base',base.href,document.baseURI,link.href]);base.remove();
  const foreign=document.implementation.createHTMLDocument(''),foreignBase=foreign.createElement('base');foreignBase.href='https://foreign.test/';foreign.head.append(foreignBase);
  const adopted=foreign.createElement('a');adopted.href='?q=Тест';results.push(['foreign',adopted.href]);document.body.append(adopted);results.push(['adopted',adopted.href]);adopted.remove();
  for(const [tag,key] of fields){const prototype=Object.getPrototypeOf(document.createElement(tag));let current=prototype,descriptor;while(!descriptor&&current){descriptor=Object.getOwnPropertyDescriptor(current,key);current=Object.getPrototypeOf(current);}let name;try{descriptor.get.call({});}catch(error){name=error.name;}results.push(['receiver',tag,name]);}
  results.push(['URL',new URL('/?q=Тест',location.href).href]);
  return results;
};

export async function verifyHTMLURLs(page,{batch=0,batches=1}={}){
  const native=await page.context().newPage(),passed=[],direct=[],requests=[];
  const selected=encodings.filter((_,index)=>index%batches===batch);
  const query='?q=Тест&japanese=日本&snow=雪';
  const entities=value=>value.replace(/[^\x00-\x7f]/gu,character=>'&#'+character.codePointAt(0)+';');
  const resources='<img id="image" src="/pixel'+entities(query)+'"><img srcset="/responsive'+entities(query)+' 1x"><video poster="/poster'+entities(query)+'"></video><script charset="Shift_JIS" src="/classic'+entities(query)+'"></script><script type="module" src="/module'+entities(query)+'"></script><link rel="stylesheet" href="/style'+entities(query)+'"><iframe src="/child'+entities(query)+'"></iframe><a id="anchor" href="/target'+entities(query)+'">Link</a><form id="form" method="post" accept-charset="UTF-8" action="/post'+entities(query)+'"><input name="field" value="one"><button id="button" formaction="/override'+entities(query)+'">Post</button></form>';
  const content=url=>{
    const path=new URL(url).pathname;
    const match=/^\/(?:matrix|resources)\/(.+)$/.exec(path);
    if(match){const encoding=decodeURIComponent(match[1]),source='<!doctype html><body>'+(path.startsWith('/resources/')?resources:'URLs');return {body:encoding==='UTF-16LE'?Buffer.from('\ufeff'+source,'utf16le'):Buffer.from(source),type:'text/html;charset='+encoding};}
    if(['/pixel','/responsive','/poster'].includes(path))return {body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=','base64'),type:'image/png'};
    if(path==='/classic'||path==='/module')return {body:Buffer.from('globalThis.'+path.slice(1)+'Ready=true;'),type:'text/javascript;charset=utf-8'};
    if(path==='/style')return {body:Buffer.from('body{--ready:1}'),type:'text/css;charset=utf-8'};
    return {body:Buffer.from('<!doctype html><body>Destination'),type:'text/html;charset=utf-8'};
  };
  await native.route('**/*',async route=>{requests.push({url:route.request().url(),method:route.request().method()});const response=content(route.request().url());await route.fulfill({body:response.body,contentType:response.type});});
  const onRequest=request=>{if(/^https?:/.test(request.url()))direct.push(request.url());};page.on('request',onRequest);
  const paths=['/pixel','/responsive','/poster','/classic','/module','/style','/child','/target','/post','/override','/fetch',...encodings.flatMap(encoding=>['/matrix/','/resources/'].map(prefix=>prefix+encodeURIComponent(encoding)))];
  const responses=Object.fromEntries([...paths,'/fallback'].map(path=>{const response=content(origin+path);return [path,{body:[...response.body],type:response.type}];}));
  await page.evaluate(({origin,responses})=>{
    globalThis.htmlURLTest={previous:sandstone.network.session.fetch,requests:[]};
    sandstone.network.session.fetch=async(url,options)=>{
      htmlURLTest.requests.push({url,method:options.method||'GET'});
      const response=responses[new URL(url).pathname]||responses['/fallback'];
      const result=new Response(new Uint8Array(response.body),{headers:{'Content-Type':response.type}});Object.defineProperty(result,'url',{value:url});return result;
    };
  },{origin,responses});
  try{
    for(const encoding of selected){
      const url=origin+'/matrix/'+encodeURIComponent(encoding);
      await native.goto(url);const expected=await native.evaluate(inspect,{fields,values});
      await page.evaluate(url=>main_frame.navigate_to(url),url);
      const actual=JSON.parse(await page.evaluate(({source,args})=>main_frame.eval_js('JSON.stringify(('+source+')('+JSON.stringify(args)+'))'),{source:inspect.toString(),args:{fields,values}}));
      assert.deepEqual(actual,expected,'HTML URL reflection: '+encoding);passed.push('HTML URL reflection and component setters match native '+encoding+' queries');
      requests.length=0;await page.evaluate(()=>{htmlURLTest.requests=[];});
      const resourceURL=origin+'/resources/'+encodeURIComponent(encoding);
      await native.goto(resourceURL);
      await native.waitForFunction(()=>globalThis.classicReady&&globalThis.moduleReady&&document.querySelector('#image').complete&&document.querySelector('#image').naturalWidth>0);
      await page.evaluate(url=>main_frame.navigate_to(url),resourceURL);
      await wait_for(()=>page.evaluate(async()=>JSON.parse(await main_frame.eval_js('JSON.stringify(!!(globalThis.classicReady&&globalThis.moduleReady&&document.querySelector("#image").complete&&document.querySelector("#image").naturalWidth>0))'))));
      await native.evaluate(()=>fetch('/fetch?q=Тест').then(response=>response.text()));
      await page.evaluate(()=>main_frame.eval_js('fetch("/fetch?q=Тест").then(response=>response.text())'));
      const paths=['/pixel','/responsive','/poster','/classic','/module','/style','/child','/fetch'];
      const filter=list=>list.filter(entry=>paths.includes(new URL(entry.url).pathname)).map(entry=>entry.url).sort();
      await page.waitForFunction(paths=>htmlURLTest.requests.filter(entry=>paths.includes(new URL(entry.url).pathname)).length>=paths.length,paths);
      assert.deepEqual(filter(await page.evaluate(()=>htmlURLTest.requests)),filter(requests),'HTML resource requests: '+encoding);
      await native.locator('#anchor').click();await native.waitForURL(url=>url.pathname==='/target');
      const target=native.url();await page.evaluate(()=>main_frame.eval_js('document.querySelector("#anchor").click();true'));
      await page.waitForFunction(target=>!main_frame.is_navigating&&main_frame.url.href===target,target);
      await native.goto(resourceURL);await page.evaluate(url=>main_frame.navigate_to(url),resourceURL);
      await native.locator('#button').click();await native.waitForURL(url=>url.pathname==='/override');
      const override=native.url();await page.evaluate(()=>main_frame.eval_js('document.querySelector("#button").click();true'));
      await page.waitForFunction(target=>!main_frame.is_navigating&&main_frame.url.href===target,override);
      assert.ok((await page.evaluate(()=>htmlURLTest.requests)).some(entry=>entry.url===override&&entry.method==='POST'));
      passed.push('HTML resources, link navigation and POST submitter actions retain native '+encoding+' query bytes');
    }
    assert.deepEqual(direct,[],'HTML URLs must stay behind the relay');return passed;
  }finally{
    await page.evaluate(()=>{sandstone.network.session.fetch=htmlURLTest.previous;delete globalThis.htmlURLTest;});
    page.off('request',onRequest);await native.close();
  }
}
