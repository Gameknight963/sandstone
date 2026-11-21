import assert from 'node:assert/strict';

export async function verifyJavascriptDocumentResults(page,{batch=0,batches=1}={}){
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage(),fixture=await page.context().newPage(),requests=[],direct=[],errors=[],differences=[];
  const diagnostics=[],origin='https://javascript-results.test',html='<!doctype html><head><base href="/creator-base/"></head><body>Before<script>globalThis.ready=true;</script>';
  const body=url=>url.endsWith('/result.js')?'globalThis.externalLoaded=true;':url.endsWith('/result.css')?'body{color:rgb(17,34,51)}':url.endsWith('/result-fetch')?'ok':html;
  const contentType=url=>url.endsWith('.js')?'text/javascript':url.endsWith('.css')?'text/css':'text/html';
  for(const surface of [native,fixture])surface.on('pageerror',error=>errors.push(error.message));
  fixture.on('console',message=>{if(message.type()==='error')diagnostics.push(message.text());});
  try{
    await native.route(origin+'/**',async route=>{
      const request=route.request();if(/\/result(?:\.js|\.css|-fetch)$/.test(new URL(request.url()).pathname))requests.push({url:request.url(),referrer:(await request.allHeaders()).referer||''});
      await route.fulfill({contentType:contentType(request.url()),headers:{'cache-control':'no-store'},body:body(request.url())});
    });
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.evaluate(({html})=>{
      globalThis.resultRequests=[];main_frame.on_load=()=>{};
      sandstone.network.session.fetch=async(url,options)=>{
        if(/\/result(?:\.js|\.css|-fetch)$/.test(new URL(url).pathname))resultRequests.push({url,referrer:new Headers(options.headers).get('referer')||''});
        return new Response(url.endsWith('/result.js')?'globalThis.externalLoaded=true;':url.endsWith('/result.css')?'body{color:rgb(17,34,51)}':url.endsWith('/result-fetch')?'ok':html,{headers:{'content-type':url.endsWith('.js')?'text/javascript':url.endsWith('.css')?'text/css':'text/html','cache-control':'no-store'}});
      };
    },{html});
    const read=(proxy,source)=>proxy?fixture.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
    const wait_child=async(proxy,url)=>{
      const deadline=Date.now()+7000;while(Date.now()<deadline){for(const frame of (proxy?fixture:native).frames())if(await frame.evaluate(({proxy,url})=>proxy?globalThis.sandstone_frame?.loader.url===url&&globalThis.ready===true:location.href===url&&globalThis.ready===true,{proxy,url}).catch(()=>false))return;await fixture.waitForTimeout(20);}throw new Error('Result source child did not load');
    };
    const markup=`<!doctype html><html><head><link rel="stylesheet" href="./result.css"><script src="./result.js"></script></head><body>After<script>
      (async()=>{
        const database=await new Promise((resolve,reject)=>{const request=indexedDB.open('javascript-results',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
        const stored=await new Promise((resolve,reject)=>{const request=database.transaction('records').objectStore('records').get('marker');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});database.close();
        const response=await fetch('./result-fetch');
        globalThis.freshResult={old:typeof oldMarker,oldReady:typeof oldReady,href:location.href,origin,base:document.baseURI,referrer:document.referrer,state:history.state,historyDelta:history.length-Number(localStorage.getItem('beforeHistory')),name:window.name,local:localStorage.getItem('marker'),session:sessionStorage.getItem('marker'),cookies:document.cookie.includes('javascript_result='+localStorage.getItem('marker')),stored,external:globalThis.externalLoaded===true,color:getComputedStyle(document.body).color,response:await response.text()};
      })();
    </script></body></html>`;
    const cases=['root-location','root-link','root-open','root-origin-policy','child-src','child-link','child-open','child-replace','initial-src','blank-src','srcdoc','initial-shadow-parent','initial-name','initial-fragment','initial-reinsert','initial-reinsert-pending','initial-document-open','initial-document-write'];
    for(const [index,kind] of cases.entries()){
      if(index%batches!==batch)continue;
      const results=[];
      for(const proxy of [false,true]){
        console.log(JSON.stringify({fixture:'JavaScript document result',kind,proxy}));
        if(proxy)await fixture.evaluate(url=>main_frame.navigate_to(url),origin+'/start');else await native.goto(origin+'/start');
        await read(proxy,`(async()=>{const database=await new Promise((resolve,reject)=>{const request=indexedDB.open('javascript-results',1);request.onupgradeneeded=()=>request.result.createObjectStore('records');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});await new Promise((resolve,reject)=>{const transaction=database.transaction('records','readwrite');transaction.objectStore('records').put(${JSON.stringify(kind)},'marker');transaction.oncomplete=resolve;transaction.onabort=()=>reject(transaction.error);});database.close();window.name='root-name';})()`);
        if(kind==='root-origin-policy')await read(proxy,'(()=>{const meta=document.createElement("meta");meta.name="referrer";meta.content="origin";document.head.append(meta);})()');
        const extra=kind==='initial-shadow-parent'?'var parent=7;':kind==='initial-name'?'window.name="changed-name";':kind==='initial-fragment'?'history.replaceState(history.state,"","about:blank#chosen");':kind==='initial-document-open'?'document.open();':kind==='initial-document-write'?'document.open();document.write("<body>Written");document.close();':'';
        const payload='globalThis.oldMarker=42;globalThis.oldReady=true;localStorage.setItem("marker",'+JSON.stringify(kind)+');sessionStorage.setItem("marker",'+JSON.stringify(kind)+');document.cookie="javascript_result='+kind+'; path=/";localStorage.setItem("beforeHistory",String(history.length));history.replaceState({seed:'+JSON.stringify(kind)+'},"");'+extra+JSON.stringify(markup);
        const javascript=JSON.stringify('javascript:'+encodeURIComponent(payload));
        if(!kind.startsWith('root-')&&!kind.startsWith('initial-')){
          await read(proxy,'globalThis.childLoads=0;globalThis.child=document.createElement("iframe");child.onload=()=>childLoads++;child.id="child";child.name="named-child";'+(kind==='blank-src'?'':kind==='srcdoc'?'child.srcdoc='+JSON.stringify(html)+';':'child.src="/child";')+'document.body.append(child);true');
          if(kind!=='blank-src')await wait_child(proxy,kind==='srcdoc'?'about:srcdoc':origin+'/child');
        }
        if(proxy)await fixture.evaluate(()=>{resultRequests=[];});else requests.length=0;
        if(kind.startsWith('initial-'))await read(proxy,'globalThis.childLoads=0;globalThis.child=document.createElement("iframe");child.onload=()=>childLoads++;child.id="child";child.name="named-child";child.src='+javascript+';document.body.append(child);'+(kind==='initial-reinsert-pending'?'child.remove();document.body.append(child);':'')+'true');
        else if(kind==='child-open')await read(proxy,'child.contentWindow.open('+javascript+',"_self");true');
        else if(kind==='child-replace')await read(proxy,'child.contentWindow.location.replace('+javascript+');true');
        else if(kind==='srcdoc')await read(proxy,'child.contentWindow.location='+javascript+';true');
        else if(kind==='root-open')await read(proxy,'open('+javascript+',"_self");true');
        else if(kind==='root-link'||kind==='child-link')await read(proxy,'(()=>{const link=document.createElement("a");link.href='+javascript+';'+(kind==='child-link'?'link.target="named-child";':'')+'document.body.append(link);link.click();})()');
        else if(kind.startsWith('root-'))await read(proxy,'location.href='+javascript+';true');
        else await read(proxy,'child.src='+javascript+';true');
        if(kind==='initial-reinsert'){
          const deadline=Date.now()+8000;
          while(!await read(proxy,'!!child.contentWindow.freshResult')){
            if(Date.now()>deadline)throw new Error('Initial result did not load before reinsertion');
            await fixture.waitForTimeout(20);
          }
          if(proxy)await fixture.evaluate(()=>{resultRequests=[];});else requests.length=0;
          await read(proxy,'child.remove();document.body.append(child);true');
        }
        const deadline=Date.now()+8000;let value;
        while(Date.now()<deadline&&!value){
          for(const frame of (proxy?fixture:native).frames())try{const found=await frame.evaluate(()=>globalThis.freshResult);if(found){value=found;break;}}catch{}
          if(!value)await fixture.waitForTimeout(20);
        }
        if(!value){
          const frames=[];
          for(const frame of (proxy?fixture:native).frames()){
            let timer;try{frames.push(await Promise.race([frame.evaluate(()=>({url:location.href,html:document.documentElement?.outerHTML.slice(0,500),runtime:!!globalThis.sandstone_frame,ready:globalThis.sandstone_frame?.loader.ready_state,pristine:globalThis.sandstone_frame?.loader.pristine_blank})),new Promise(resolve=>{timer=setTimeout(()=>resolve({unavailable:true}),500);})]));}catch{}finally{clearTimeout(timer);}
          }
          throw new Error('JavaScript result did not finish: '+JSON.stringify({kind,proxy,errors,diagnostics,frames}));
        }
        let frame=null;
        if(!kind.startsWith('root-')){
          const expectedLoads=kind==='initial-document-write'||kind==='initial-reinsert'||!kind.startsWith('initial-')?2:1;
          const deadline=Date.now()+8000;
          while(await read(proxy,'childLoads')<expectedLoads){if(Date.now()>deadline)throw new Error('Missing iframe load event: '+JSON.stringify({kind,proxy}));await fixture.waitForTimeout(20);}
          frame=JSON.parse(await read(proxy,'JSON.stringify({loads:childLoads,src:child.getAttribute("src"),reflected:child.src})'));
        }
        const network=proxy?await fixture.evaluate(()=>resultRequests):[...requests];network.sort((a,b)=>a.url.localeCompare(b.url));results.push({value,network,frame});
      }
      assert.equal(results[0].value.old,kind.startsWith('initial-')&&!kind.startsWith('initial-document-')?'number':'undefined');assert.equal(results[0].value.historyDelta,0);
      try{assert.deepEqual(results[1],results[0]);}catch{differences.push({kind,actual:results[1],expected:results[0]});}
    }
    assert.deepEqual(direct,[],'Returned JavaScript HTML bypassed the relay');assert.deepEqual(errors,[],'Returned JavaScript HTML raised script errors');
    assert.deepEqual(differences,[],'JavaScript document results preserve native globals, history, storage and relayed resources');
  }finally{await nativeContext.close();await fixture.close();}
  return ['JavaScript string results create fresh root/child documents while retaining URL, history state and stored site data','Returned HTML scripts, styles and fetch use the relay with native base URLs and referrer policies'];
}
