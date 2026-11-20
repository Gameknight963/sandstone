import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';

function resource(input,method='GET'){
  const url=new URL(input),kind=url.searchParams.get('kind');
  const headers={'content-type':'text/html;charset=utf-8','cache-control':'no-store'};
  if(url.pathname==='/start')return {status:302,headers:{...headers,location:'/middle?kind='+kind+(kind==='override'?'#next':kind==='clear'?'#':'')},body:'redirect'};
  if(url.pathname==='/middle')return {status:307,headers:{...headers,location:'/end?kind='+kind},body:'redirect'};
  if(url.pathname==='/bad')return {status:302,headers:{...headers,location:'http://['},body:'invalid redirect'};
  if(url.pathname==='/empty')return {status:302,headers:{...headers,location:''},body:'empty redirect'};
  const form=url.pathname==='/form'?'<form method="POST" action="/start?kind=post#section"><input name="value" value="posted"><button>Submit</button></form>':'';
  return {status:200,headers,body:'<!doctype html><title>Redirect navigation</title><body>'+form+'<input id="section"><input id="next"><input id="caf\u00e9"><div id="method">'+method+'</div>'};
}
const snapshot='({path:location.pathname,search:location.search,hash:location.hash,fragment:location.href.includes("#"),method:document.getElementById("method").textContent})';
const api=`(async()=>{
  const result={};
  for(const path of ['/end?kind=direct#section','/start?kind=inherit#section','/start?kind=override#section','/start?kind=clear#section','/empty','/bad']){
    try{
      const response=await fetch(path),clone=response.clone(),borrowed=Response.prototype.clone.call(response),again=Response.prototype.clone.call(borrowed),url=new URL(response.url),cloneURL=new URL(clone.url);
      const describe=value=>{const url=new URL(value.url);return {url:url.pathname+url.search+url.hash,metadataMatches:['status','statusText','ok','type','redirected'].every(key=>value[key]===response[key])};};
      const body=await response.text();
      result[path]={status:response.status,redirected:response.redirected,url:url.pathname+url.search+url.hash,clone:cloneURL.pathname+cloneURL.search+cloneURL.hash,sameBody:body===await clone.text(),borrowed:describe(borrowed),again:describe(again),borrowedBody:body===await borrowed.text()&&body===await again.text()};
    }catch(error){result[path]={error:error.name};}
  }
  const xhr=new XMLHttpRequest();await new Promise((resolve,reject)=>{xhr.onload=resolve;xhr.onerror=reject;xhr.open('GET','/start?kind=inherit#section');xhr.send();});
  const url=new URL(xhr.responseURL);result.xhr={status:xhr.status,url:url.pathname+url.search+url.hash};
  const cache=await caches.open('redirect-response-url'),fresh=await fetch('/end?kind=cached#section');await cache.put('/saved',Response.prototype.clone.call(fresh));await fresh.text();
  const stored=await cache.match('/saved'),copy=stored.clone(),borrowed=Response.prototype.clone.call(stored),storedURL=new URL(stored.url),copyURL=new URL(copy.url),borrowedURL=new URL(borrowed.url),body=await stored.text();
  result.cache={url:storedURL.pathname+storedURL.search+storedURL.hash,clone:copyURL.pathname+copyURL.search+copyURL.hash,sameBody:body===await copy.text(),borrowed:{url:borrowedURL.pathname+borrowedURL.search+borrowedURL.hash,metadataMatches:['status','statusText','ok','type','redirected'].every(key=>borrowed[key]===stored[key]),sameBody:body===await borrowed.text()}};
  return result;
})()`;

export async function verifyRedirectNavigation(page){
  const server=createServer((request,response)=>{
    const data=resource('http://'+request.headers.host+request.url,request.method);
    response.writeHead(data.status,data.headers);response.end(data.body);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  const context=await page.context().browser().newContext(),native=await context.newPage(),fixture=await page.context().newPage(),errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));
  try{
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
    await fixture.evaluate(source=>{
      const resource=eval('('+source+')');sandstone.network.session.fetch=async(url,options={})=>{
        const data=resource(url,options.method||'GET');return new Response(data.body,{status:data.status,headers:data.headers});
      };
    },resource.toString());
    for(const [kind,hash] of [['inherit','#section'],['override','#section'],['clear','#section'],['encoded','#caf%C3%A9']]){
      const path='/start?kind='+kind+hash;await native.goto(origin+path);
      const expected=await native.evaluate(source=>eval(source),snapshot);
      await fixture.evaluate(url=>main_frame.navigate_to(url),'https://redirect-navigation.test'+path);
      const actual=JSON.parse(await fixture.evaluate(source=>main_frame.eval_js('JSON.stringify('+source+')'),snapshot));
      assert.deepEqual(actual,expected,kind);
    }
    await native.goto(origin+'/form');await native.getByRole('button',{name:'Submit',exact:true}).click();
    await native.waitForURL(url=>url.pathname==='/end');const expected=await native.evaluate(source=>eval(source),snapshot);
    assert.equal(expected.hash,'#section');assert.equal(expected.method,'GET');
    await fixture.evaluate(()=>main_frame.navigate_to('https://redirect-navigation.test/form'));
    await fixture.frameLocator('iframe[frame-id]').getByRole('button',{name:'Submit',exact:true}).click();
    await fixture.waitForFunction(()=>main_frame.url.pathname==='/end'&&!main_frame.is_navigating);
    assert.deepEqual(JSON.parse(await fixture.evaluate(source=>main_frame.eval_js('JSON.stringify('+source+')'),snapshot)),expected);
    const expectedAPI=await native.evaluate(source=>eval(source),api);
    assert.equal(expectedAPI['/end?kind=direct#section'].url,'/end?kind=direct');assert.equal(expectedAPI['/bad'].error,'TypeError');
    assert.deepEqual(JSON.parse(await fixture.evaluate(source=>main_frame.eval_js('(async()=>JSON.stringify(await ('+source+')))()'),api)),expectedAPI);
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['HTTP redirects inherit, replace and clear fragments across navigation and POST-to-GET form redirects','Fetch, cloned and cached responses hide URL fragments while XHR retains native redirect URLs and errors'];
  }finally{await fixture.close();await context.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await page.bringToFront();}
}
