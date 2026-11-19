import assert from 'node:assert/strict';

const names=['sec-fetch-dest','sec-fetch-mode','sec-fetch-site','sec-fetch-user'];
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const wav=Buffer.alloc(124,128);
wav.write('RIFF');wav.writeUInt32LE(116,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(8000,28);
wav.writeUInt16LE(1,32);wav.writeUInt16LE(8,34);wav.write('data',36);wav.writeUInt32LE(80,40);
export function metadata_fixture(){
  const requests=[];let origin,other;
  const path=(name,client,id,base=origin)=>base+'/metadata/'+name+'?'+new URLSearchParams({client,id});
  return {
    configure(main,secondary){origin=main;other=secondary;},
    profiles(client){
      const seen=new Set();
      return requests.filter(item=>item.client===client).map(({id,headers})=>({id,...headers})).filter(value=>{
        const key=JSON.stringify(value);if(!value.id.includes('history')&&!value.id.startsWith('reload-')&&seen.has(key))return false;seen.add(key);return true;
      }).sort((a,b)=>a.id.localeCompare(b.id));
    },
    handle(request,response,url){
      if(!url.pathname.startsWith('/metadata/'))return false;
      const client=url.searchParams.get('client'),id=url.searchParams.get('id');
      if(client&&id)requests.push({client,id,headers:{origin:request.headers.origin??null,...Object.fromEntries(names.filter(name=>name in request.headers).map(name=>[name,request.headers[name]]))}});
      const headers={'Cache-Control':'no-store','Access-Control-Allow-Origin':request.headers.origin||'*','Access-Control-Allow-Credentials':'true','Permissions-Policy':'unload=(self)'};
      const send=(type,body)=>{response.writeHead(200,{...headers,'Content-Type':type});response.end(body);return true;};
      const route=url.pathname.slice('/metadata/'.length);
      if(route==='echo')return send('application/json','{}');
      if(route==='image')return send('image/png',png);
      if(route==='wav')return send('audio/wav',wav);
      if(route==='track')return send('text/vtt','WEBVTT\n\n00:00.000 --> 00:00.010\nReady\n');
      if(route==='script')return send('text/javascript','globalThis.metadataLoaded=true;');
      if(route==='bare-style')return send('text/css','.metadata{color:rgb(1,2,3)}');
      if(route==='style'){
        return send('text/css','@import url('+JSON.stringify(path('bare-style',client,'css-import'))+'); .metadata{background-image:url('+JSON.stringify(path('image',client,'css-image'))+');width:2px;height:2px}');
      }
      if(route==='worker'){
        const module=url.searchParams.has('module');
        const imported=path('script',client,module?'module-worker-dependency':'worker-import');
        const dynamic=path('script',client,module?'module-worker-dynamic':'worker-dynamic');
        return send('text/javascript',(module?'import '+JSON.stringify(imported)+';':'importScripts('+JSON.stringify(imported)+');')+
          'import('+JSON.stringify(dynamic)+').then(()=>fetch('+JSON.stringify(path('echo',client,id+'-fetch'))+')).then(()=>postMessage("ready"));');
      }
      if(route==='sse')return send('text/event-stream','data: ready\n\n');
      if(route==='redirect'){
        response.writeHead(302,{...headers,Location:url.searchParams.get('to')});response.end();return true;
      }
      let script='addEventListener("unload",()=>{});';
      const history=url.searchParams.get('child-history');
      if(history){
        const next=path('page',client,'child-history-second',origin.replace('127.0.0.1','localhost'))+'&child-history=second';
        script+='addEventListener("message",event=>{if(event.data==="metadata-next")location.assign('+JSON.stringify(next)+');if(event.data==="metadata-back")history.back();});parent.postMessage('+JSON.stringify('metadata-history-'+history)+',"*");';
      }
      if(url.searchParams.has('opaque'))script+='fetch('+JSON.stringify(path('echo',client,'opaque-fetch'))+').then(()=>parent.postMessage("metadata-opaque","*"));';
      if(url.searchParams.has('inner'))script+='fetch('+JSON.stringify(path('echo',client,'ancestor-fetch'))+').then(()=>top.postMessage("metadata-ancestor","*"));';
      const child=url.searchParams.has('ancestor')?'<iframe src="'+path('page',client,'ancestor-inner')+'&inner=1"></iframe>':'';
      return send('text/html','<!doctype html><body><a id="metadata-link" href="'+path('page',client,'clicked-nav')+'">Next</a>'+
        '<form id="metadata-form" action="/metadata/page"><input name="client" value="'+client+'"><input name="id" value="form-click"><button id="metadata-submit">Submit</button></form>'+
        '<div class="metadata"></div>'+child+'<script>'+script+'</script>');
    }
  };
}

async function resources({origin,other,client}){
  const url=(route,id,base=origin)=>base+'/metadata/'+route+'?'+new URLSearchParams({client,id});
  const cross=origin.replace('127.0.0.1','localhost');
  await fetch(url('echo','fetch'));
  await fetch(url('echo','fetch-no-cors'),{mode:'no-cors'});
  await fetch(url('echo','fetch-same-origin'),{mode:'same-origin'});
  await fetch(url('echo','same-site',other));
  await fetch(url('echo','cross-site',cross));
  await fetch(url('echo','forged'),{headers:{'Sec-Fetch-Dest':'document','Sec-Fetch-Mode':'navigate','Sec-Fetch-Site':'none','Sec-Fetch-User':'?1','Sec-Fetch-Unknown':'forged'}});
  await fetch(url('redirect','redirect-start')+'&to='+encodeURIComponent(url('redirect','redirect-cross',cross)+'&to='+encodeURIComponent(url('echo','redirect-return'))));
  await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST',url('echo','xhr'));xhr.onload=resolve;xhr.onerror=reject;xhr.send('body');});
  if(!navigator.sendBeacon(url('echo','beacon-text'),'body')||!navigator.sendBeacon(url('echo','beacon-json'),new Blob(['{}'],{type:'application/json'})))throw new Error('Metadata beacon refused');
  const add=(tag,address,properties={})=>new Promise(resolve=>{
    const element=document.createElement(tag);Object.assign(element,properties);element.onload=element.onerror=resolve;
    element[tag==='link'?'href':'src']=address;document.body.append(element);
  });
  await add('img',url('image','image'));
  await add('img',url('image','image-cors'),{crossOrigin:'anonymous'});
  await add('script',url('script','script'));
  await add('script',url('script','module'),{type:'module'});
  await add('link',url('bare-style','stylesheet'),{rel:'stylesheet'});
  await add('link',url('style','stylesheet-cors'),{rel:'stylesheet',crossOrigin:'anonymous'});
  const media=(tag,id,cors=false)=>new Promise(resolve=>{
    const element=document.createElement(tag);element.preload='auto';if(cors)element.crossOrigin='anonymous';
    element.onloadedmetadata=element.onerror=()=>resolve(element);element.src=url('wav',id);document.body.append(element);element.load();
  });
  await media('audio','audio');await media('audio','audio-cors',true);
  const video=await media('video','video'),videoCors=await media('video','video-cors',true);
  for(const [parent,id] of [[video,'track'],[videoCors,'track-cors']])await new Promise(resolve=>{
    const track=document.createElement('track');track.onload=track.onerror=resolve;track.src=url('track',id);parent.append(track);track.track.mode='hidden';
  });
  await add('iframe',url('page','iframe'));
  const message=async(data,address,opaque=false)=>new Promise(resolve=>{
    const receive=event=>{if(event.data!==data)return;removeEventListener('message',receive);resolve();};
    addEventListener('message',receive);const frame=document.createElement('iframe');
    if(opaque)frame.sandbox='allow-scripts';frame.src=address;document.body.append(frame);
  });
  await message('metadata-opaque',url('page','opaque-iframe')+'&opaque=1',true);
  await message('metadata-ancestor',url('page','ancestor-outer',cross)+'&ancestor=1');
  for(const module of [false,true])await new Promise((resolve,reject)=>{
    const worker=new Worker(url('worker',module?'module-worker':'worker')+(module?'&module=1':''),{type:module?'module':'classic'});
    worker.onmessage=()=>{worker.terminate();resolve();};worker.onerror=reject;
  });
  await new Promise((resolve,reject)=>{
    const worker=new Worker(URL.createObjectURL(new Blob(['fetch('+JSON.stringify(url('echo','blob-worker-fetch'))+').then(()=>postMessage("ready"));'],{type:'text/javascript'})));
    worker.onmessage=()=>{worker.terminate();resolve();};worker.onerror=reject;
  });
  await new Promise((resolve,reject)=>{const events=new EventSource(url('sse','sse'));events.onmessage=()=>{events.close();resolve();};events.onerror=reject;});
  return true;
}

export async function verify_metadata(driver,fixture,origin,other,client){
  const url=id=>origin+'/metadata/page?'+new URLSearchParams({client,id});
  await driver.navigate(url('address'));
  await driver.evaluate('('+resources.toString()+')('+JSON.stringify({origin,other,client})+')');
  // Avoid making native resource scheduling part of the expected profile.
  const pending=['css-image','beacon-text','beacon-json'];
  for(let count=0;count<500&&pending.some(id=>!fixture.profiles(client).some(value=>value.id===id));count++)await new Promise(resolve=>setTimeout(resolve,10));
  for(const id of pending)assert.ok(fixture.profiles(client).some(value=>value.id===id),'Missing metadata profile '+id);
  await driver.navigate(url('reset-script'));
  await driver.evaluate('location.assign('+JSON.stringify(url('script-nav'))+')');
  await driver.wait(url('script-nav'));
  await driver.navigate(url('reset-click'));
  await driver.click('#metadata-link');
  await driver.wait(url('clicked-nav'));
  await driver.navigate(url('reset-form'));
  await driver.evaluate('document.getElementById("metadata-form").elements.id.value="form-script";document.getElementById("metadata-form").submit();');
  await driver.wait(url('form-script'));
  await driver.navigate(url('reset-form-click'));
  await driver.click('#metadata-submit');
  await driver.wait(url('form-click'));
  await driver.navigate(url('reset-spoof'));
  await driver.evaluate('Object.defineProperty(Navigator.prototype,"userActivation",{get:()=>({isActive:true,hasBeenActive:true})});Object.defineProperty(UserActivation.prototype,"isActive",{get:()=>true});location.assign('+JSON.stringify(url('spoof-nav'))+');');
  await driver.wait(url('spoof-nav'));
  await driver.navigate(url('reset-child-history'));
  const childFirst=url('child-history-first')+'&child-history=first';
  await driver.evaluate('new Promise(resolve=>{const receive=e=>{if(e.data==="metadata-history-first"){removeEventListener("message",receive);resolve(true);}};addEventListener("message",receive);const frame=document.createElement("iframe");frame.id="metadata-history-child";frame.src='+JSON.stringify(childFirst)+';document.body.append(frame);})');
  for(const [command,ready] of [['metadata-next','metadata-history-second'],['metadata-back','metadata-history-first']]){
    await driver.evaluate('new Promise(resolve=>{const receive=e=>{if(e.data==='+JSON.stringify(ready)+'){removeEventListener("message",receive);resolve(true);}};addEventListener("message",receive);document.getElementById("metadata-history-child").contentWindow.postMessage('+JSON.stringify(command)+',"*");})');
  }
  for(const initial of ['ui','ui-state','script','script-state']){
    if(initial.startsWith('ui'))await driver.navigate(url('history-'+initial));
    else{await driver.navigate(url('reset-history-'+initial));await driver.evaluate('location.assign('+JSON.stringify(url('history-'+initial))+')');await driver.wait(url('history-'+initial));}
    if(initial.endsWith('-state'))await driver.evaluate('history.replaceState({request_metadata:{site:"none",user:true}},"",location.href)');
    await driver.evaluate('location.assign('+JSON.stringify(url('history-after-'+initial))+')');await driver.wait(url('history-after-'+initial));
    await driver.evaluate('history.back()');await driver.wait(url('history-'+initial));
  }
  for(const initial of ['ui','script']){
    const target=url('reload-'+initial);
    if(initial==='ui')await driver.navigate(target);
    else{await driver.navigate(url('reset-reload-script'));await driver.evaluate('location.assign('+JSON.stringify(target)+')');await driver.wait(target);}
    const count=()=>fixture.profiles(client).filter(value=>value.id==='reload-'+initial).length;
    const before=count();await driver.evaluate('location.reload()');
    for(let tries=0;tries<500&&count()===before;tries++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(count()>before,'Script reload did not request '+initial+' metadata');
    await driver.wait(target);await driver.reload();await driver.wait(target);
  }
  const profiles=fixture.profiles(client).filter(value=>!value.id.startsWith('reset-'));
  for(const id of ['fetch','image','stylesheet','worker','module-worker','opaque-fetch','redirect-return','script-nav','clicked-nav','spoof-nav'])assert.ok(profiles.some(value=>value.id===id),'Missing metadata profile '+id);
  return profiles;
}

const sessions=new WeakMap();
export async function metadata_evaluate(page,proxy,source){
  let session=sessions.get(page);if(!session){session=await page.context().newCDPSession(page);sessions.set(page,session);}
  const expression=proxy?'main_frame.eval_js('+JSON.stringify(source)+')':'(0,eval)('+JSON.stringify(source)+')';
  const result=await session.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:false});
  if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
