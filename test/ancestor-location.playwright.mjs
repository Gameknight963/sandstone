import assert from 'node:assert/strict';

const origin='https://ancestor-location.test',other='https://ancestor-location-other.test';
const cases=[
  {receiver:'parent',method:'window'},
  {receiver:'top',method:'window'},
  {receiver:'parent.parent',method:'href'},
  {receiver:'parent',method:'assign'},
  {receiver:'parent',method:'replace'},
  {receiver:'parent',method:'reload'},
  {receiver:'top',method:'hash',sandbox:'allow-scripts allow-same-origin',blocked:true},
  {receiver:'top',method:'hash',sandbox:'allow-scripts allow-same-origin allow-top-navigation'},
  {receiver:'top',method:'hash',sandbox:'allow-scripts allow-same-origin allow-top-navigation-by-user-activation'},
  {receiver:'top',method:'reload',sandbox:'allow-scripts allow-same-origin'},
  {receiver:'parent',method:'setter'},
  {receiver:'top',method:'setter',cross:true},
  {receiver:'parent',method:'probe'},
  {receiver:'parent',method:'probe',cross:true},
  {receiver:'top',method:'replace',cross:true},
  {receiver:'top',method:'href',cross:true},
  {receiver:'leafWindow',method:'window',source:'root'},
  {receiver:'leafWindow.parent',method:'href',source:'root'},
  {receiver:'leafWindow',method:'href',source:'root',cross:true},
  {receiver:'leafWindow.parent',method:'replace',source:'root',cross:true}
];

export async function verifyAncestorLocation(page){
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage(),fixture=await page.context().newPage();
  const direct=[],errors=[],requests=[],middleRequests=[];
  let current;
  const program=test=>{
    if(test.method==='probe'){
      const probe=function(target){
        const attempt=operation=>{try{return {value:operation()??null};}catch(error){return {error:error.name};}};
        const probe={
          location:attempt(()=>typeof target.location),href:attempt(()=>target.location.href),origin:attempt(()=>target.location.origin),
          assign:attempt(()=>typeof target.location.assign),replace:attempt(()=>typeof target.location.replace),reload:attempt(()=>typeof target.location.reload),string:attempt(()=>String(target.location)),
          missingAssign:attempt(()=>target.location.assign()),missingReplace:attempt(()=>target.location.replace()),
          invalidURL:attempt(()=>target.location.replace('https://[')),symbolURL:attempt(()=>Reflect.set(target.location,'href',Symbol('url'))),receiver:attempt(()=>target.location.replace.call({},'landing')),
          synthetic:attempt(()=>{let reads=0;dispatchEvent(new MessageEvent('message',{data:{get sandstone_message(){reads++;return 'author data';},get frame(){reads++;return 'author frame';}}}));return reads;})
        };
        top.postMessage({probe},'*');
      };
      return '('+probe.toString()+')('+test.receiver+')';
    }
    if(test.method==='setter')return 'Object.getOwnPropertyDescriptor(window,"location").set.call('+test.receiver+',"landing")';
    if(test.method==='reload')return test.receiver+'.location.reload()';
    if(test.method==='hash')return test.receiver+'.location.hash="destination"';
    return test.method==='window'?test.receiver+'.location="landing"':test.method==='href'?test.receiver+'.location.href="landing"':test.receiver+'.location.'+test.method+'("landing")';
  };
  const html=(url,test)=>{
    const path=new URL(url).pathname;
    if(path==='/parent')return '<!doctype html><base href="/root-base/"><body><script>globalThis.instance=Math.random();globalThis.messages=[];globalThis.leafReady=false;globalThis.middleLoads=0;onmessage=event=>{if(event.data?.ready){globalThis.leafWindow=event.source;leafReady=true;}else if(event.data?.arrived)messages.push({...event.data,source:event.source===globalThis.savedDestination});else if(event.data?.probe)globalThis.privacyProbe=event.data.probe;else if(event.data?.failure)globalThis.failure=event.data.failure;};</script><button id="go">Navigate</button><iframe id="middle" onload="middleLoads++" src="'+origin+'/middle'+(test.method==='reload'?'#start':'')+'"></iframe><script>document.getElementById("go").onclick=()=>{try{'+(test.source==='root'?program(test):'')+';}catch(error){globalThis.failure=error.name;}};</script>';
    if(path==='/middle')return '<!doctype html><base href="/middle-base/"><body><iframe id="leaf" '+(test.sandbox?'sandbox="'+test.sandbox+'" ':'')+'src="'+(test.cross?other:origin)+'/leaf"></iframe>';
    if(path==='/leaf')return '<!doctype html><base href="/leaf-base/"><body><button id="go">Navigate</button><script>document.getElementById("go").onclick=()=>{try{'+(test.source!=='root'?program(test):'')+';}catch(error){top.postMessage({failure:error.name},"*");}};top.postMessage({ready:true},"*");</script>';
    return '<!doctype html><body>Landing<script>globalThis.landed=true;globalThis.arrival={url:location.href,referrer:document.referrer};top.postMessage({arrived:arrival},"*");</script>';
  };
  const read=(proxy,source)=>proxy?fixture.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const wait=async(predicate,label)=>{const deadline=Date.now()+8000;while(!await predicate()){if(direct.length)throw new Error('Ancestor navigation made a direct request: '+direct.join(', '));if(Date.now()>deadline)throw new Error(label);await fixture.waitForTimeout(20);}};
  try{
    for(const surface of [native,fixture])surface.on('pageerror',error=>errors.push(error.message));
    await native.route(/^https:\/\/ancestor-location(?:-other)?\.test\//,async route=>{
      const request=route.request();if(new URL(request.url()).pathname.endsWith('/landing'))requests.push({proxy:false,url:request.url(),referrer:(await request.allHeaders()).referer||''});
      if(new URL(request.url()).pathname==='/middle')middleRequests.push({url:request.url(),referrer:(await request.allHeaders()).referer||''});
      await route.fulfill({contentType:'text/html',headers:{'cache-control':'no-store'},body:html(request.url(),current)});
    });
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.evaluate(({body,origin,other,source})=>{
      const program=(0,eval)('('+source+')'),html=eval('('+body+')');globalThis.ancestorLocation={test:null,requests:[],middleRequests:[]};main_frame.on_load=()=>{};
      sandstone.network.session.fetch=async(url,options)=>{
        if(new URL(url).pathname.endsWith('/landing'))ancestorLocation.requests.push({url,referrer:new Headers(options.headers).get('referer')||''});
        if(new URL(url).pathname==='/middle')ancestorLocation.middleRequests.push({url:url.split('#')[0],referrer:new Headers(options.headers).get('referer')||''});
        return new Response(html(url,ancestorLocation.test),{headers:{'content-type':'text/html','cache-control':'no-store'}});
      };
    },{body:html.toString(),origin,other,source:program.toString()});
    for(const test of cases){
      current=test;const results=[],rootTarget=test.source!=='root'&&test.receiver!=='parent';
      for(const proxy of [false,true]){
        console.log(JSON.stringify({fixture:'Ancestor Location',...test,proxy}));
        if(proxy){await fixture.evaluate(test=>{ancestorLocation.test=test;ancestorLocation.requests=[];ancestorLocation.middleRequests=[];},test);await fixture.evaluate(url=>main_frame.navigate_to(url),origin+'/parent');}
        else{requests.length=0;middleRequests.length=0;await native.goto(origin+'/parent');}
        await wait(()=>read(proxy,'leafReady&&middleLoads===1'),'The ancestor navigation source did not load');
        const beforeHistory=await read(proxy,'history.length');
        const beforeInstance=await read(proxy,'instance'),beforeNavigation=proxy?await fixture.evaluate(()=>main_frame.navigation_id):null;
        if(test.method==='hash'||test.blocked)await read(proxy,'globalThis.savedRootDocument=document;true');
        await read(proxy,'globalThis.savedDestination='+(test.source==='root'?test.receiver:'document.getElementById("middle").contentWindow')+';true');
        if(test.method==='reload'&&!test.blocked)await read(proxy,'globalThis.savedDocument=savedDestination.document;true');
        let surface=proxy?fixture.frameLocator('iframe[frame-id]'):native;
        if(test.source!=='root')surface=surface.frameLocator('#middle').frameLocator('#leaf');
        await surface.locator('#go').click();
        if(test.method==='reload'&&rootTarget){
          if(proxy)await fixture.waitForFunction(id=>main_frame.navigation_id>id&&!main_frame.is_navigating,beforeNavigation);
          await wait(()=>read(proxy,'leafReady&&middleLoads===1&&instance!=='+JSON.stringify(beforeInstance)),'The ancestor root did not reload');
          const snapshot=JSON.parse(await read(proxy,'JSON.stringify({url:location.href,referrer:document.referrer,history:history.length})'));snapshot.history-=beforeHistory;
          assert.equal(snapshot.url,origin+'/parent');assert.equal(snapshot.history,0);results.push(snapshot);continue;
        }
        if(test.method==='hash'||test.blocked){
          if(test.blocked)await fixture.waitForTimeout(100);
          else await wait(()=>read(proxy,'location.hash==="#destination"'),'The activated sandbox navigation did not finish');
          const snapshot=JSON.parse(await read(proxy,'JSON.stringify({url:location.href,same:document===savedRootDocument,history:history.length,failure:globalThis.failure||null})'));snapshot.history-=beforeHistory;
          assert.equal(snapshot.url,origin+'/parent'+(test.blocked?'':'#destination'));assert.equal(snapshot.same,true);assert.equal(snapshot.history,test.blocked?0:1);
          assert.equal(snapshot.failure,test.blocked?'SecurityError':null);
          assert.equal(proxy?await fixture.evaluate(()=>ancestorLocation.requests.length):requests.length,0);results.push(snapshot);continue;
        }
        if(test.method==='reload'){
          await wait(()=>read(proxy,'middleLoads===2'),'The ancestor did not reload');
          const snapshot=JSON.parse(await read(proxy,'JSON.stringify({url:savedDestination.location.href,same:savedDestination.document===savedDocument,loads:middleLoads})'));
          snapshot.requests=proxy?await fixture.evaluate(()=>ancestorLocation.middleRequests):[...middleRequests];
          assert.equal(snapshot.same,false);assert.equal(snapshot.requests.length,2);results.push(snapshot);continue;
        }
        if(test.method==='probe'){
          await wait(()=>read(proxy,'!!globalThis.privacyProbe'),'The ancestor access probe did not finish');
          results.push(JSON.parse(await read(proxy,'JSON.stringify(privacyProbe)')));
          assert.equal(proxy?await fixture.evaluate(()=>ancestorLocation.requests.length):requests.length,0,'An access probe navigated an ancestor');
          continue;
        }
        const expected=(test.source==='root'?origin:test.cross?other:origin)+(test.source==='root'?'/root-base/landing':'/leaf-base/landing');
        if(rootTarget){
          await wait(()=>proxy?fixture.evaluate(url=>main_frame.url.href===url&&!main_frame.is_navigating,expected):Promise.resolve(native.url()===expected),'The ancestor root navigation did not finish');
          await wait(()=>read(proxy,'globalThis.landed===true'),'The ancestor root destination did not execute');
          const snapshot=JSON.parse(await read(proxy,'JSON.stringify({arrival,history:history.length})'));snapshot.history-=beforeHistory;results.push(snapshot);
        }else{
          await wait(async()=>{const state=JSON.parse(await read(proxy,'JSON.stringify({failure:globalThis.failure,messages})'));if(state.failure)throw new Error('Ancestor navigation failed: '+state.failure);return state.messages.length>0;},'The ancestor destination did not report its navigation');
          results.push(JSON.parse(await read(proxy,'JSON.stringify(messages.at(-1))')));
        }
        const sent=proxy?await fixture.evaluate(()=>ancestorLocation.requests):requests.filter(value=>!value.proxy).map(({url,referrer})=>({url,referrer}));
        assert.equal(sent.length,1,'An ancestor navigation fetched more than one destination');assert.equal(sent[0].url,expected);results.at(-1).request=sent[0];
      }
      assert.deepEqual(results[1],results[0],JSON.stringify(test));
    }
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    assert.equal(fixture.url(),new URL('../example/bundled.html',import.meta.url).href,'Ancestor navigation changed the standalone host URL');
  }finally{await fixture.close();await nativeContext.close();}
  return ['Parent/top Location assignment and methods navigate virtual ancestors behind the relay with native source bases and referrers','Cross-origin activated navigation and nested message-source Location receivers select the intended virtual window'];
}
