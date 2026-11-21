import assert from 'node:assert/strict';

export async function verifyJavascriptNavigation(page){
  const native=await page.context().newPage(),fixture=await page.context().newPage(),requests=[],direct=[],errors=[],differences=[];
  const origin='https://javascript-navigation.test',cross='https://javascript-navigation-other.test';
  const html=url=>new URL(url).pathname==='/start'?'<html><head><base href="/root-base/"></head><body>Parent':'<html><head><base href="/child-base/"></head><body>Child<script>globalThis.childReady=true;globalThis.priorChild=true;</script>';
  fixture.on('pageerror',error=>errors.push(error.message));
  try{
    await native.route(/^https:\/\/javascript-navigation(?:-other)?\.test\//,async route=>{
      const request=route.request();if(new URL(request.url()).pathname.endsWith('/probe'))requests.push({url:request.url(),referrer:(await request.allHeaders()).referer||''});
      await route.fulfill({contentType:'text/html',headers:{'cache-control':'no-store'},body:html(request.url())});
    });
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.evaluate(body=>{
      const html=(0,eval)('('+body+')');globalThis.javascriptRequests=[];main_frame.on_load=()=>{};
      sandstone.network.session.fetch=async(url,options)=>{
        if(new URL(url).pathname.endsWith('/probe'))javascriptRequests.push({url,referrer:new Headers(options.headers).get('referer')||''});
        return new Response(html(url),{headers:{'content-type':'text/html','cache-control':'no-store'}});
      };
    },html.toString());
    const read=(proxy,source)=>proxy?fixture.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
    const wait_child=async(proxy,url)=>{
      const deadline=Date.now()+7000;
      while(Date.now()<deadline){
        for(const frame of (proxy?fixture:native).frames())if(await frame.evaluate(({proxy,url})=>proxy?globalThis.sandstone_frame?.loader.url===url&&globalThis.childReady===true:location.href===url&&globalThis.childReady===true,{proxy,url}).catch(()=>false))return;
        await fixture.waitForTimeout(20);
      }
      throw new Error('JavaScript navigation child did not load: '+url);
    };
    const snapshot=async proxy=>{
      const values=[];
      for(const frame of (proxy?fixture:native).frames())try{
        let timer,value;
        try{value=await Promise.race([frame.evaluate(proxy=>proxy?globalThis.sandstone_frame?.context.run_script('globalThis.javascriptResult&&JSON.stringify({...javascriptResult,lexicalSurvives:typeof javascriptLexical})'):globalThis.javascriptResult&&JSON.stringify({...javascriptResult,lexicalSurvives:eval('typeof javascriptLexical')}),proxy),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Frame context is unavailable')),500);})]);}
        finally{clearTimeout(timer);}
        if(value)values.push(JSON.parse(value));
      }catch{}
      return values;
    };
    const script='let javascriptLexical=7;var javascriptVar=8;globalThis.javascriptResult={href:location.href,base:document.baseURI,referrer:document.referrer,prior:globalThis.priorChild===true,self:window===self&&window===globalThis,currentScript:document.currentScript===null,varConfigurable:Object.getOwnPropertyDescriptor(window,"javascriptVar").configurable};fetch("./probe").catch(()=>{});void 0';
    for(const [kind,sandbox,childOrigin,blocked] of [
      ['initial-src',null,origin,false],['loaded-src',null,origin,false],['link-target',null,origin,false],['open-target',null,origin,false],['location-target',null,origin,false],
      ['self-link',null,origin,false],['self-location',null,origin,false],['loaded-src',null,cross,true],['link-target',null,cross,true],
      ['initial-src','allow-scripts',origin,true],['initial-src','allow-same-origin',origin,true]
    ]){
      const results=[];
      for(const proxy of [false,true]){
        console.log(JSON.stringify({fixture:'JavaScript navigation',kind,sandbox,childOrigin,proxy}));
        if(proxy)await fixture.evaluate(url=>main_frame.navigate_to(url),origin+'/start');else await native.goto(origin+'/start');
        if(proxy)await fixture.evaluate(()=>{javascriptRequests=[];});else requests.length=0;
        const code=JSON.stringify('javascript:'+script),sandboxCode=sandbox===null?'':'child.sandbox='+JSON.stringify(sandbox)+';';
        if(kind==='initial-src')await read(proxy,'globalThis.childLoads=0;globalThis.child=document.createElement("iframe");child.onload=()=>childLoads++;child.id="child";child.name="target";'+sandboxCode+'child.src='+code+';document.body.append(child);true');
        else if(!kind.startsWith('self-')){
          await read(proxy,'globalThis.childLoads=0;globalThis.child=document.createElement("iframe");child.onload=()=>childLoads++;child.id="child";child.name="target";'+sandboxCode+'child.src='+JSON.stringify(childOrigin+'/child')+';document.body.append(child);true');
          await wait_child(proxy,childOrigin+'/child');
          if(kind==='loaded-src')await read(proxy,'child.src='+code+';true');
          else if(kind==='open-target')await read(proxy,'child.contentWindow.open('+code+',"_self");true');
          else if(kind==='location-target')await read(proxy,'child.contentWindow.location='+code+';true');
          else await read(proxy,'(()=>{const link=document.createElement("a");link.target="target";link.href='+code+';document.body.append(link);link.click();})()');
        }else if(kind==='self-link')await read(proxy,'(()=>{const link=document.createElement("a");link.href='+code+';document.body.append(link);link.click();})()');
        else await read(proxy,'location.href='+code+';true');
        const deadline=Date.now()+5000;let values=[];
        do{
          values=await snapshot(proxy);const sent=proxy?await fixture.evaluate(()=>javascriptRequests.length):requests.length;
          if(!blocked&&values.length&&sent)break;
          if(blocked&&Date.now()>deadline-4700)break;
          if(Date.now()>deadline)throw new Error('JavaScript navigation did not run: '+JSON.stringify({kind,proxy}));
          await fixture.waitForTimeout(20);
        }while(true);
        if(kind==='initial-src'&&!blocked){
          const deadline=Date.now()+3000;while(!await read(proxy,'childLoads')){if(Date.now()>deadline)throw new Error('Missing initial JavaScript iframe load');await fixture.waitForTimeout(20);}
        }
        results.push({values,requests:proxy?await fixture.evaluate(()=>javascriptRequests):[...requests],loads:kind.startsWith('self-')?null:await read(proxy,'childLoads')});
      }
      if(blocked){assert.deepEqual(results[0].values,[],'Native cross-origin/sandbox JavaScript navigation is blocked');assert.deepEqual(results[0].requests,[]);}
      try{assert.deepEqual(results[1],results[0]);}catch{differences.push({kind,sandbox,childOrigin,actual:results[1],expected:results[0]});}
    }
    assert.deepEqual(differences,[],'JavaScript navigation retains the target document and request context');
    assert.deepEqual(direct,[],'JavaScript navigation bypassed the relay');assert.deepEqual(errors,[],'JavaScript navigation raised script errors');
  }finally{await native.close();await fixture.close();}
  return ['Initial/loaded iframe JavaScript URLs, targeted links, Window.open and Location execute in the destination behind the relay','JavaScript navigation preserves target URL/base/referrer and rejects cross-origin and sandboxed execution'];
}
