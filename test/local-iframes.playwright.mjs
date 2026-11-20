import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';

export async function verifyLocalIframes(page){
  const html='<!doctype html><body>Local iframe parent';
  const server=createServer((request,response)=>{
    response.setHeader('access-control-allow-origin','*');
    response.setHeader('content-type',request.url==='/echo'?'text/plain':'text/html');
    response.end(request.url==='/echo'?'relayed':html);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  const nativeContext=await page.context().browser().newContext();
  const databaseSource=`async function databaseValue(write){
    const request=indexedDB.open('local-iframe',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('values');
    const database=await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
    try{return await new Promise((resolve,reject)=>{
      const transaction=database.transaction('values',write?'readwrite':'readonly'),store=transaction.objectStore('values');
      const operation=write?store.put('database','shared'):store.get('shared');let value;
      operation.onsuccess=()=>value=operation.result;transaction.oncomplete=()=>resolve(value);transaction.onabort=()=>reject(transaction.error);
    });}finally{database.close();}
  }`;
  const childSource=`(async()=>{${databaseSource}
    const result={origin:globalThis.origin,locationOrigin:location.origin,protocol:location.protocol,baseProtocol:new URL(document.baseURI).protocol,referrer:document.referrer,rtc:typeof RTCPeerConnection};
    try{result.local=localStorage.getItem('local-frame');localStorage.setItem('child-write','saved')}catch(error){result.local=error.name}
    try{result.session=sessionStorage.getItem('local-frame')}catch(error){result.session=error.name}
    try{document.cookie='child-cookie=ignored; Path=/';result.cookie=document.cookie}catch(error){result.cookie=error.name}
    try{result.database=await databaseValue(false)}catch(error){result.database=error.name}
    try{result.shared=await(await fetch(SHARED_BLOB)).text()}catch(error){result.shared=error.name}
    if(result.origin!=='null'){
      history.replaceState(null,'',location.href+'#creator');
      const nested=document.createElement('iframe');
      await new Promise(resolve=>{nested.onload=resolve;document.body.append(nested)});
      result.nestedLocal=nested.contentWindow.localStorage.getItem('local-frame');
      result.nestedCookie=nested.contentDocument.cookie;
      const written=nested.contentDocument;written.open();written.write('<!doctype html><body>Written local frame');written.close();
      nested.contentWindow.history.replaceState({written:true},'',nested.contentWindow.location.href.split('#')[0]+'#written');
      result.written={protocol:new URL(nested.contentWindow.location.href).protocol,origin:nested.contentWindow.location.origin,globalOrigin:nested.contentWindow.origin,cookie:written.cookie,body:written.body.textContent,baseProtocol:new URL(written.baseURI).protocol,referrerProtocol:written.referrer?new URL(written.referrer).protocol:null,referrerIsCreator:written.referrer===location.href};
      result.written.state=nested.contentWindow.history.state;result.written.echo=await(await nested.contentWindow.fetch(${JSON.stringify(origin+'/echo')})).text();
      nested.remove();
    }
    result.echo=await(await fetch(${JSON.stringify(origin+'/echo')})).text();
    parent.postMessage({localFrameResult:result},'*');
  })().catch(error=>parent.postMessage({localFrameError:error.message},'*'));`;
  function source(kind,sandbox,mode='src'){
    return `(async()=>{${databaseSource}
      localStorage.removeItem('child-write');localStorage.setItem('local-frame','shared');sessionStorage.setItem('local-frame','session');document.cookie='parent-cookie=kept; Path=/';
      await databaseValue(true);
      const payload=URL.createObjectURL(new Blob(['shared payload']));let frame=document.createElement('iframe');
      ${sandbox?`frame.sandbox=${mode==='blocked'?"''":"'allow-scripts'"};`:''}
      const markup='<!doctype html><body>Local child<script>parent.postMessage({localFrameAttempt:true},"*");'+${JSON.stringify(childSource)}.replace('SHARED_BLOB',JSON.stringify(payload))+'</scr'+'ipt>';
      const target=${kind==='blob'?"URL.createObjectURL(new Blob([markup],{type:'text/html;charset=utf-8'}))":"'data:text/html;charset=utf-8,'+encodeURIComponent(markup)"};
      ${mode==='parsed'?`const container=document.createElement('div');container.innerHTML='<iframe src="'+target+'"></iframe>';frame=container.firstChild;`:''}
      ${mode==='blocked'?`try{return await new Promise((resolve,reject)=>{
        let attempted=false;const receive=event=>{if(event.source===frame.contentWindow&&event.data?.localFrameAttempt)attempted=true;};
        const timer=setTimeout(()=>{removeEventListener('message',receive);reject(new Error('Sandboxed local iframe timed out'));},7000);
        addEventListener('message',receive);frame.onload=()=>setTimeout(()=>{clearTimeout(timer);removeEventListener('message',receive);resolve(JSON.stringify({attempted,sandbox:frame.getAttribute('sandbox')}));},20);
        frame.src=target;document.body.append(frame);
      });}finally{frame.remove();URL.revokeObjectURL(payload);URL.revokeObjectURL(target);}`:''}
      try{return await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{removeEventListener('message',receive);reject(new Error('Local iframe timed out'))},7000);
        function receive(event){
          if(event.source!==frame.contentWindow||!event.data?.localFrameResult&&!event.data?.localFrameError)return;
          clearTimeout(timer);removeEventListener('message',receive);
          if(event.data.localFrameError){reject(new Error(event.data.localFrameError));return;}
          const result={snapshot:event.data.localFrameResult,messageOrigin:event.origin,parentLocal:localStorage.getItem('child-write'),parentCookie:document.cookie,readable:!!frame.contentDocument};
          if(frame.contentDocument)result.reflectedOrigin=frame.contentWindow.location.origin;
          resolve(JSON.stringify(result));
        }
        addEventListener('message',receive);
        ${mode==='location'?'document.body.append(frame);frame.contentWindow.location.assign(target);':mode==='parsed'?'document.body.append(frame);':'frame.src=target;document.body.append(frame);'}
      });}finally{frame.remove();URL.revokeObjectURL(payload);if(${JSON.stringify(kind)}==='blob')URL.revokeObjectURL(target);}
    })()`;
  }
  try{
    for(const [kind,sandbox,mode] of [['blob',false,'src'],['data',false,'src'],['blob',true,'src'],['data',false,'parsed'],['blob',false,'location'],['blob',true,'blocked'],['data',true,'blocked']]){
      const native=await nativeContext.newPage(),fixture=await page.context().newPage(),direct=[],errors=[];
      try{
        await native.goto(origin+'/page');
        const expected=JSON.parse(await native.evaluate(source=>eval(source),source(kind,sandbox,mode)));
        await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);
        await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
        await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
        await fixture.evaluate(async({origin,html})=>{
          main_frame.on_load=()=>{};globalThis.localIframeRequests=[];
          sandstone.network.session.fetch=async url=>{localIframeRequests.push(url);return new Response(url.endsWith('/echo')?'relayed':html,{headers:{'content-type':url.endsWith('/echo')?'text/plain':'text/html'}});};
          await main_frame.navigate_to(origin+'/page');
        },{origin,html});
        fixture.on('pageerror',error=>errors.push(error.message));
        fixture.on('console',message=>{if(message.type()==='error'&&message.text().includes('History URLs'))errors.push(message.text());});
        const actual=JSON.parse(await fixture.evaluate(source=>main_frame.eval_js(source),source(kind,sandbox,mode)));
        if(mode==='blocked')assert.deepEqual(actual,{attempted:false,sandbox:''},'Authored sandbox must prevent local HTML scripts');
        else{
          assert.equal(actual.snapshot.rtc,'undefined','Local documents must not expose a direct WebRTC connection');
          delete actual.snapshot.rtc;delete expected.snapshot.rtc;
        }
        assert.deepEqual(actual,expected,kind+(sandbox?' sandboxed':'')+' '+mode+' native origin/storage/message parity');
        if(mode!=='blocked')assert.ok((await fixture.evaluate(()=>localIframeRequests)).includes(origin+'/echo'),'Local frame fetch must use the relay');
        assert.deepEqual(direct,[],'Local frame attempted a direct HTTP request');
        assert.deepEqual(errors,[],'Local frame runtime reported an error');
      }finally{await fixture.close();await native.close();await nativeContext.clearCookies();}
    }
    return ['Blob HTML frames inherit their creator origin, localStorage and IndexedDB while cookies remain unavailable','Data and sandboxed Blob HTML frames retain opaque origins and storage restrictions','Local iframe messages, shared Blob reads and HTTP fetches preserve origin checks and use the relay without WebRTC'];
  }finally{await nativeContext.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
