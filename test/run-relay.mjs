import {create_relay_server} from '../example/http.mjs';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {pathToFileURL, fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {server as wisp} from '../example/node_modules/@mercuryworkshop/wisp-js/src/entrypoints/server.mjs';
import {WebSocketServer} from '../example/node_modules/ws/wrapper.mjs';
import {font_fixture, font_script, constructor_font_script} from './font-fixture.mjs';
import {keepalive_fixture,keepalive_quota_script,keepalive_finish_script,keepalive_unload_script,keepalive_abort_script,keepalive_worker_script} from './keepalive-fixture.mjs';
import {cache_fixture,cache_script} from './cache-fixture.mjs';
import {download_fixture,verify_downloads,prepare_downloads} from './download-fixture.mjs';
import {cookie_fixture,verify_cookie_storage,verify_embedded_cookies} from './cookie-fixture.mjs';
import {module_requests_fixture,verify_module_requests} from './module-requests-fixture.mjs';
import {empty_headers_fixture,empty_headers_script,verify_empty_headers} from './empty-headers-fixture.mjs';
import {transport_fixture,verify_transport_entries} from './transport-fixture.mjs';
import {upload_fixture,upload_script,verify_uploads,verify_relay_uploads} from './upload-fixture.mjs';

// Real libcurl/Wisp coverage, separate from the mocked transport fixtures. This
// relay binds only loopback and permits connections only to this test's port.
const held=new Map(),requests=[],closed=[],sockets=new Set(),timers=new Set();
const authRequests=[];
const beaconRequests=[],heldBeacons=new Map();
const contextRequests=[];
const cssRequests=[];
const fonts=font_fixture();
const keepalive=keepalive_fixture();
const cacheFixture=cache_fixture();
const downloadFixture=download_fixture();
const moduleRequests=module_requests_fixture();
const later=(callback,delay)=>{const timer=setTimeout(()=>{timers.delete(timer);callback();},delay);timers.add(timer);};
const server=create_relay_server((request,response)=>{
  const url=new URL(request.url,'http://localhost');
  const client=url.searchParams.get('client');
  if(fonts.handle(request,response,url))return;
  if(keepalive.handle(request,response,url))return;
  if(cacheFixture.handle(request,response,url))return;
  if(downloadFixture.handle(request,response,url))return;
  if(moduleRequests.handle(request,response,url))return;
  if(empty_headers_fixture(request,response,url))return;
  if(transport_fixture(request,response,url))return;
  if(upload_fixture(request,response,url))return;
  if(cookie_fixture(request,response,url))return;
  if(url.pathname.startsWith('/css-context/')){
    const policy=url.searchParams.get('policy')||'';
    const query='?client='+encodeURIComponent(client)+'&policy='+encodeURIComponent(policy);
    cssRequests.push({client,path:url.pathname,referrer:request.headers.referer||null});
    if(url.pathname.endsWith('/page')){
      response.writeHead(200,{'Content-Type':'text/html','Referrer-Policy':'origin'});
      response.end('<!doctype html><link rel="stylesheet" '+(policy==='link-no-referrer'?'referrerpolicy="no-referrer" ':'')+'href="/css-context/redirect'+query+'"><body><div id="root">root</div><div id="child">child</div>');
    }else if(url.pathname.endsWith('/redirect')){
      response.writeHead(302,{Location:'/css-context/root.css'+query});response.end();
    }else if(url.pathname.endsWith('.css')){
      const root=url.pathname.endsWith('/root.css');
      response.writeHead(200,{'Content-Type':'text/css',...(root?(policy&&policy!=='link-no-referrer'?{'Referrer-Policy':policy}:{}):{'Referrer-Policy':'no-referrer'})});
      const cross='http://localhost:'+request.headers.host.split(':').at(-1)+'/css-context/';
      response.end(root?'@import "'+cross+'child.css'+query+'"; #root{background-image:url(root.svg'+query+'),url('+cross+'cross.svg'+query+');padding-left:17px}':'#child{background-image:url(child.svg'+query+');padding-left:19px}');
    }else{
      response.writeHead(200,{'Content-Type':'image/svg+xml'});response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    }
    return;
  }
  if(url.pathname==='/request-context/source'){
    response.writeHead(200,{'Content-Type':'text/html','Set-Cookie':['ctx_session=secret; HttpOnly; SameSite=Strict; Path=/','ctx_default=default; Path=/','ctx_invalid=invalid; SameSite=unknown; Path=/'],...(url.searchParams.has('policy')?{'Referrer-Policy':url.searchParams.get('policy')}:{})});
    const meta=url.searchParams.has('meta')?'<meta name="referrer" content='+JSON.stringify(url.searchParams.get('meta'))+'>':'';
    const script=url.searchParams.has('script')?'<script src="/request-context/script?client='+encodeURIComponent(url.searchParams.get('script'))+'&label=declared-meta"></script>':'';
    response.end('<!doctype html><title>Request context fixture</title>'+meta+script+'<body>Request context fixture</body>');return;
  }
  if(url.pathname.startsWith('/request-context/')){
    const cors={'Access-Control-Allow-Origin':request.headers.origin||'*','Access-Control-Allow-Credentials':'true','Access-Control-Allow-Methods':'GET, POST','Access-Control-Allow-Headers':'content-type'};
    if(request.method==='OPTIONS'){response.writeHead(204,cors);response.end();return;}
    const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{
      contextRequests.push({client,label:url.searchParams.get('label'),method:request.method,origin:request.headers.origin??null,referrer:request.headers.referer??null,cookie:request.headers.cookie?.split('; ').filter(value=>value.startsWith('ctx_')).join('; ')||'',body:Buffer.concat(chunks).toString()});
      if(url.pathname==='/request-context/redirect')response.writeHead(307,{...cors,Location:url.searchParams.get('target'),...(url.searchParams.has('policy')?{'Referrer-Policy':url.searchParams.get('policy')}:{})});
      else response.writeHead(200,{...cors,'Content-Type':url.pathname.endsWith('/script')?'application/javascript':'text/plain'});
      response.end(url.pathname.endsWith('/script')?'':'received');
    });return;
  }
  if(url.pathname==='/beacon'){
    const chunks=[];
    request.on('data',chunk=>chunks.push(chunk));
    request.on('end',()=>{
      beaconRequests.push({client,name:url.searchParams.get('name'),body:Buffer.concat(chunks),type:request.headers['content-type']||'',cookie:request.headers.cookie||'',origin:request.headers.origin});
      if(url.searchParams.has('hold'))heldBeacons.set(client,response);
      else {response.writeHead(204,{'Set-Cookie':'beacon=visible; Path=/'});response.end();}
    });return;
  }
  if(url.pathname==='/beacon-child'){
    response.writeHead(200,{'Content-Type':'text/html'});
    const ready='/beacon?client='+encodeURIComponent(client)+'&name=ready';
    const unload='/beacon?client='+encodeURIComponent(client)+'&name=unload&hold=1';
    response.end('<!doctype html><script>navigator.sendBeacon('+JSON.stringify(ready)+',"child ready");addEventListener("unload",()=>navigator.sendBeacon('+JSON.stringify(unload)+',"child unload"));</script>');return;
  }
  if(url.pathname==='/ws-login'){
    response.writeHead(200,{'Set-Cookie':[
      'auth_session=token; HttpOnly; SameSite=Strict; Path=/ws-auth',
      'auth_login=visible; SameSite=Lax; Path=/',
      'auth_wrong=hidden; Path=/unrelated', 'auth_expired=old; Max-Age=0; Path=/'
    ]});response.end('logged in');return;
  }
  if(url.pathname==='/ws-cookies'){
    response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(request.headers.cookie||''));return;
  }
  if(url.pathname==='/redirect'){
    response.writeHead(302,{Location:'/events?'+url.searchParams,'Set-Cookie':'redirect=visible; Path=/'});response.end();return;
  }
  if(url.pathname==='/pending'){server.emit('pending',response);return;}
  if(url.pathname==='/lifecycle-stream-child'){
    response.writeHead(200,{'Content-Type':'text/html','Permissions-Policy':'unload=(self)'});
    response.end('<!doctype html><script>globalThis.retainedSource=new EventSource('+JSON.stringify('/events?client='+client)+');</script>');return;
  }
  if(url.pathname==='/events'){
    const count=requests.filter(value=>value.client===client).length+1;
    requests.push({client,count,id:Buffer.from(request.headers['last-event-id']||'','latin1').toString('utf8'),cookie:request.headers.cookie||''});
    held.set(client,{response,count});
    response.on('close',()=>closed.push({client,count}));
    response.writeHead(200,{'Content-Type':'text/event-stream;charset=utf-8','Set-Cookie':'stream=visible; Path=/'});
    response.flushHeaders(); // No body until onopen causes the /release request.
    return;
  }
  if(url.pathname==='/release'){
    const entry=held.get(client);
    if(entry){
      const text=entry.count===1?'\ufeff: heartbeat\r\nretry: 5\r\nid: 漢字-€\r\nevent: update\r\ndata: first €\r\ndata: second line\r\n\r\n':entry.count===2?'data: second\n\nid:\n\n':'data: final\n\n';
      const bytes=Buffer.from(text);
      // Split UTF-8 sequences and CRLF boundaries across actual network chunks.
      const split=entry.count===1?bytes.indexOf(Buffer.from('漢'))+1:3;
      entry.response.write(bytes.subarray(0,split));
      later(()=>{if(!entry.response.destroyed)entry.response.write(bytes.subarray(split));if(entry.count<3)entry.response.end();},10);
    }
    response.end('released');return;
  }
  if(url.pathname==='/stop'){response.writeHead(204);response.end();return;}
  if(url.pathname==='/wrong'){response.writeHead(200,{'Content-Type':'text/plain'});response.end('not SSE');return;}
  response.writeHead(200,{'Content-Type':'text/html'});response.end('<!doctype html><body>Native SSE baseline</body>');
});
server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
const echoes = new WebSocketServer({noServer: true, handleProtocols: protocols => protocols.has('second') ? 'second' : false});
echoes.on('headers',(headers,request)=>{
  if(new URL(request.url,'http://localhost').pathname==='/ws-auth')headers.push(
    'Set-Cookie: auth_visible=handshake; SameSite=Lax; Path=/',
    'Set-Cookie: auth_hidden=secret; HttpOnly; SameSite=Strict; Path=/'
  );
});
echoes.on('connection', (socket, request) => {
  if(request.url==='/ws-context')socket.send(JSON.stringify({origin:request.headers.origin,cookies:(request.headers.cookie||'').split('; ').filter(Boolean).sort()}));
  if (request.url === '/ws-close') { socket.close(4001, 'server finished'); return; }
  socket.on('message', (data, isBinary) => socket.send(data, {binary: isBinary}));
});
server.on('upgrade',(request,socket,head)=>{
  const path=new URL(request.url,'http://localhost').pathname;
  if(path==='/ws-close'&&Object.hasOwn(request.headers,'sec-websocket-protocol')){
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');return;
  }
  if(path==='/ws-auth'){
    authRequests.push({cookie:request.headers.cookie||'',origin:request.headers.origin});
    if(!request.headers.cookie?.split('; ').includes('auth_session=token') || request.headers.origin!=='http://'+request.headers.host){
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');return;
    }
    echoes.handleUpgrade(request,socket,head,ws=>echoes.emit('connection',ws,request));
  }
  else if (request.url === '/echo' || request.url === '/ws-close' || request.url==='/ws-context') echoes.handleUpgrade(request,socket,head,ws=>echoes.emit('connection',ws,request));
  else if (request.url === '/ws-pending') server.emit('ws-pending',socket);
  else if (request.url === '/ws-refused') socket.end('HTTP/1.1 403 Forbidden\r\nSet-Cookie: refused=visible; Path=/\r\nContent-Length: 0\r\n\r\n');
  else wisp.routeRequest(request,socket,head);
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`;
wisp.options.allow_loopback_ips=true;wisp.options.port_whitelist=[server.address().port];
const channel=process.env.BROWSER_CHANNEL||'chrome';
const opaqueSocketChild=`const socket=new WebSocket(${JSON.stringify(origin.replace('http:','ws:')+'/ws-context')});socket.onmessage=event=>{parent.postMessage({socketContext:JSON.parse(event.data)},'*');socket.close();};socket.onerror=()=>parent.postMessage({socketContextError:true},'*');`;
const opaqueSocketScript=`new Promise((resolve,reject)=>{
  const child=document.createElement('iframe');child.sandbox='allow-scripts';
  const cleanup=()=>{clearTimeout(timer);removeEventListener('message',receive);child.remove();};
  const receive=event=>{if(event.source!==child.contentWindow)return;if(event.data?.socketContext){cleanup();resolve(event.data.socketContext);}else if(event.data?.socketContextError){cleanup();reject(new Error('Opaque frame socket failed'));}};
  const timer=setTimeout(()=>{cleanup();reject(new Error('Opaque frame socket timed out'));},10000);
  addEventListener('message',receive);child.srcdoc=${JSON.stringify('<script>'+opaqueSocketChild+'</script>')};document.body.append(child);
})`;
let browser;
const sourceScript=(client,redirect=false,syntheticUnload=false)=>`new Promise((resolve,reject)=>{
  const events=[];
  const source=new EventSource(${JSON.stringify(origin+(redirect?'/redirect':'/events')+'?client='+client)},{withCredentials:true});
  const timeout=setTimeout(()=>{source.close();reject(new Error('SSE timed out: '+JSON.stringify(events)));},15000);
  source.onopen=()=>{events.push(['open',source.readyState]);if(${syntheticUnload})for(const type of ['beforeunload','unload'])globalThis.dispatchEvent(new Event(type));fetch(${JSON.stringify(origin+'/release?client='+client)}).catch(reject);};
  source.onerror=()=>events.push(['error',source.readyState]);
  const message=event=>{
    events.push([event.type,event.data,event.lastEventId,event.origin]);
    if(event.data==='final'){source.close();clearTimeout(timeout);resolve(JSON.stringify(events));}
  };
  source.addEventListener('update',message);source.onmessage=message;
})`;
const streamLifecycleScript=client=>`(async()=>{
  const frame=document.createElement('iframe');frame.src=${JSON.stringify(origin+'/lifecycle-stream-child?client='+client)};document.body.append(frame);
  let source;const end=Date.now()+10000;
  while(!source||source.readyState!==EventSource.OPEN){
    source=frame.contentWindow?.retainedSource;
    if(Date.now()>end){frame.remove();throw new Error('Child event stream did not open');}
    if(!source||source.readyState!==EventSource.OPEN)await new Promise(resolve=>setTimeout(resolve,10));
  }
  try{
    const before=source.readyState;frame.contentWindow.dispatchEvent(new Event('unload'));const synthetic=source.readyState;
    frame.remove();await new Promise(resolve=>setTimeout(resolve,20));
    return JSON.stringify({before,synthetic,removed:source.readyState});
  }finally{source.close();frame.remove();}
})()`;
const websocketScript = `new Promise((resolve,reject)=>{
  const socket=new WebSocket(${JSON.stringify(origin.replace('http:','ws:')+'/echo')},['first','second']);
  const values=[];
  const timeout=setTimeout(()=>{socket.close();reject(new Error('WebSocket echo timeout: '+JSON.stringify(values)));},10000);
  socket.binaryType='arraybuffer';
  socket.onerror=()=>reject(new Error('WebSocket echo failed'));
  socket.onopen=function(event){
    if(this!==socket || event.target!==socket || socket.protocol!=='second') {reject(new Error('WebSocket open metadata'));return;}
    socket.send(new Blob(['blob first'])); socket.send('text second');
    const bytes=new Uint8Array([0,2,3,0]);socket.send(new DataView(bytes.buffer,1,2));bytes.fill(9);
    socket.send('last');
  };
  socket.onmessage=event=>{
    values.push(typeof event.data==='string'?event.data:Array.from(new Uint8Array(event.data)));
    if(values.length===4)socket.close();
  };
  socket.onclose=()=>{clearTimeout(timeout);resolve(JSON.stringify({values,state:socket.readyState,buffered:socket.bufferedAmount}));};
})`;
const authenticatedScript=`(async()=>{
  await fetch(${JSON.stringify(origin+'/ws-login')});
  const visible=await new Promise((resolve,reject)=>{
    const socket=new WebSocket(${JSON.stringify(origin.replace('http:','ws:')+'/ws-auth')});
    const timeout=setTimeout(()=>{socket.close();reject(new Error('Authenticated WebSocket timeout'));},10000);
    let snapshot;
    socket.onopen=()=>{snapshot=document.cookie;socket.close();};
    socket.onerror=()=>reject(new Error('Authenticated handshake failed'));
    socket.onclose=()=>{clearTimeout(timeout);resolve(snapshot);};
  });
  const sent=await (await fetch(${JSON.stringify(origin+'/ws-cookies')})).json();
  const auth=value=>value.split('; ').filter(cookie=>cookie.startsWith('auth_')).sort();
  return JSON.stringify({visible:auth(visible),sent:auth(sent)});
})()`;
const beaconScript=client=>`(()=>{
  const target=${JSON.stringify(origin+'/beacon?client='+client+'&name=')};
  const form=new FormData();form.append('message','one\\ntwo');form.append('file',new Blob(['file contents'],{type:'text/plain'}),'hello.txt');
  const bytes=new Uint8Array([0,2,3,0]);
  const values=[navigator.sendBeacon(target+'text','saved €'),navigator.sendBeacon(target+'params',new URLSearchParams({q:'a b'})),
    navigator.sendBeacon(target+'blob',new Blob(['{"saved":true}'],{type:'application/json'})),
    navigator.sendBeacon(target+'binary',new DataView(bytes.buffer,1,2)),navigator.sendBeacon(target+'form',form),navigator.sendBeacon(target+'empty')];
  bytes.fill(9);form.set('message','changed');
  values.push(navigator.sendBeacon(target+'oversized',new Blob([new Uint8Array(65537)])));
  for(const invoke of [()=>navigator.sendBeacon(),()=>navigator.sendBeacon('file:///local'),()=>navigator.sendBeacon(target+'stream',new ReadableStream())]){
    try{invoke();values.push('no exception');}catch(error){values.push(error.name);}
  }
  return JSON.stringify(values);
})()`;
const contextScript=client=>`(async()=>{
  const own=${JSON.stringify(origin)},cross=own.replace('127.0.0.1','localhost'),client=${JSON.stringify(client)};
  const endpoint=(base,label)=>base+'/request-context/echo?client='+client+'&label='+label;
  const cases=[
    ['get',own,{}],['post',own,{method:'POST',body:'saved'}],['cross-get',cross,{}],['cross-post',cross,{method:'POST',body:'saved'}],
    ['no-cors',cross,{method:'POST',body:'saved',mode:'no-cors'}],['no-referrer',own,{referrerPolicy:'no-referrer',method:'POST',body:'saved'}],
    ['private-no-cors',cross,{referrerPolicy:'no-referrer',method:'POST',body:'saved',mode:'no-cors'}],['origin-only',own,{referrerPolicy:'origin'}],
    ['chosen',own,{referrer:'/request-context/chosen#fragment',referrerPolicy:'unsafe-url'}],['empty',own,{referrer:''}],['unsafe',cross,{referrerPolicy:'unsafe-url'}]
  ];
  for(const [label,base,options] of cases){const response=await fetch(endpoint(base,label),options);await response.arrayBuffer();}
  for(const [label,base,options] of cases){
    const url=endpoint(base,'request-'+label);
    const request=new Request(base===own?url.slice(own.length):url,options);
    const response=await fetch(request.clone());await response.arrayBuffer();
  }
  for(const [label,base,target,policy] of [['out',own,cross,''],['back',cross,own,''],['policy-change',own,cross,'no-referrer']]){
    const url=new URL(base+'/request-context/redirect');url.searchParams.set('client',client);url.searchParams.set('label',label+'-start');url.searchParams.set('target',endpoint(target,label+'-finish'));if(policy)url.searchParams.set('policy',policy);
    await (await fetch(url,{method:'POST',body:'redirected'})).arrayBuffer();
  }
  let blocked;try{await fetch(endpoint(cross,'blocked'),{mode:'same-origin'});}catch(error){blocked=error.name;}
  const meta=document.createElement('meta');meta.name='referrer';meta.content='no-referrer';document.head.append(meta);
  await (await fetch(endpoint(own,'meta'),{method:'POST',body:'meta'})).arrayBuffer();
  meta.content='invalid, origin';await (await fetch(endpoint(own,'meta-invalid'))).arrayBuffer();
  meta.remove();await (await fetch(endpoint(own,'meta-removed'))).arrayBuffer();
  return JSON.stringify({blocked,policy:document.referrerPolicy});
})()`;
const contextValues=client=>contextRequests.filter(value=>value.client===client).map(({client,...value})=>({...value,body:value.body.replace('client='+encodeURIComponent(client)+'&','')}));
const cssValues=client=>cssRequests.filter(value=>value.client===client&&!value.path.endsWith('/page')).map(({client,...value})=>({...value,referrer:value.referrer?.replace('client='+encodeURIComponent(client)+'&','client=CLIENT&')||null})).sort((a,b)=>a.path.localeCompare(b.path));
const cssEditScript=client=>`(async()=>{
  let sheet;const deadline=Date.now()+5000;
  while(!(sheet=document.querySelector('link[rel="stylesheet"]').sheet)||sheet.cssRules.length<2||getComputedStyle(document.querySelector('#child')).paddingLeft!=='19px'){
    if(Date.now()>deadline)throw new Error('External stylesheet missing');await new Promise(resolve=>setTimeout(resolve,10));
  }
  sheet.cssRules[1].style.backgroundImage='url("/css-context/edited.svg?client='+${JSON.stringify(client)}+'")';
  sheet.insertRule('#child {border-image-source:url("/css-context/inserted.svg?client='+${JSON.stringify(client)}+'")}',sheet.cssRules.length);
  return getComputedStyle(document.querySelector('#child')).paddingLeft;
})()`;
async function waitCSS(client){
  const deadline=Date.now()+10000;
  while(cssValues(client).length<8){if(Date.now()>deadline)throw new Error('CSS requests timed out: '+JSON.stringify(cssValues(client)));await new Promise(resolve=>setTimeout(resolve,10));}
}
const formCases=[['same','POST',false,'origin'],['cross','POST',true,'origin'],['private','POST',false,'no-referrer'],['get-cross','GET',true,'origin']];
const submitFormScript=(client,label,method,target)=>`(()=>{
  const form=document.createElement('form');form.method=${JSON.stringify(method)};form.action=${JSON.stringify(target+'/request-context/echo?client='+client+'&label='+label)};
  for(const [name,value] of [['client',${JSON.stringify(client)}],['label',${JSON.stringify(label)}],['saved','yes']]){const input=document.createElement('input');input.name=name;input.value=value;form.append(input);}
  document.body.append(form);setTimeout(()=>form.requestSubmit(),0);return true;
})()`;
async function waitBeacons(client,count){
  const deadline=Date.now()+10000;
  while(beaconRequests.filter(value=>value.client===client).length<count){
    if(Date.now()>deadline)throw new Error('Beacon delivery timed out: '+client+' '+JSON.stringify(beaconRequests.map(({client,name})=>({client,name}))));
    await new Promise(resolve=>setTimeout(resolve,10));
  }
}
async function beaconBodies(client){
  return Promise.all(beaconRequests.filter(value=>value.client===client).map(async value=>{
    let body=value.body.toString('hex'),type=value.type.toLowerCase();
    if(type.startsWith('multipart/form-data')){
      const data=await new Response(value.body,{headers:{'Content-Type':value.type}}).formData();
      body=await Promise.all([...data].map(async([name,item])=>[name,typeof item==='string'?item:{name:item.name,type:item.type,text:await item.text()}]));type='multipart/form-data';
    }
    return {name:value.name,type,body,origin:value.origin};
  })).then(values=>values.sort((a,b)=>a.name.localeCompare(b.name)));
}
try{
  browser=await chromium.launch({channel:channel==='headless'?undefined:channel,headless:true});
  const nativeContext=await browser.newContext(),nativePage=await nativeContext.newPage();
  await nativePage.goto(origin);
  const baseline=JSON.parse(await nativePage.evaluate(source=>eval(source),sourceScript('native')).catch(error=>{console.error(JSON.stringify({requests,held:[...held.keys()]}));throw error;}));
  const lifecycleBaseline=JSON.parse(await nativePage.evaluate(source=>eval(source),sourceScript('lifecycle-native',false,true)));
  const retainedStreamBaseline=JSON.parse(await nativePage.evaluate(source=>eval(source),streamLifecycleScript('retained-native')));
  assert.deepEqual(retainedStreamBaseline,{before:1,synthetic:1,removed:2});
  const authBaseline=JSON.parse(await nativePage.evaluate(source=>eval(source),authenticatedScript));
  assert.deepEqual(authBaseline,{visible:['auth_login=visible','auth_visible=handshake'],sent:['auth_hidden=secret','auth_login=visible','auth_visible=handshake']});
  const opaqueSocketBaseline=await nativePage.evaluate(source=>eval(source),opaqueSocketScript);
  assert.deepEqual(opaqueSocketBaseline,{origin:'null',cookies:[]});
  const beaconBaseline=JSON.parse(await nativePage.evaluate(source=>eval(source),beaconScript('native')));
  assert.deepEqual(beaconBaseline,[true,true,true,true,true,true,false,'TypeError','TypeError','TypeError']);
  await waitBeacons('native',6);const nativeBeaconBodies=await beaconBodies('native');
  await nativePage.goto(origin+'/request-context/source?policy=origin#fragment');
  const nativeContextResult=JSON.parse(await nativePage.evaluate(source=>eval(source),contextScript('native')));
  const nativeRequestContexts=contextValues('native');
  assert.equal(nativeRequestContexts.find(value=>value.label==='post').origin,origin);
  assert.equal(nativeRequestContexts.find(value=>value.label==='meta').referrer,null);
  const nativeCookieStorage=await verify_cookie_storage(url=>nativePage.goto(url),source=>nativePage.evaluate(source=>eval(source),source),origin);
  const nativeEmbeddedCookies=await verify_embedded_cookies(nativePage,url=>nativePage.goto(url),source=>nativePage.evaluate(source=>eval(source),source),origin);
  await nativePage.goto(origin+'/request-context/source?policy=origin&meta=no-referrer&script=meta-native');
  const nativeDeclaredMeta=contextValues('meta-native');assert.equal(nativeDeclaredMeta.length,1);assert.equal(nativeDeclaredMeta[0].referrer,null);
  await nativePage.goto(origin+'/downloads/page?client=downloads-native');
  const nativeDownloads=await verify_downloads(nativePage,source=>nativePage.evaluate(source=>eval(source),source),'downloads-native',()=>nativePage.locator('#download-trigger').click());
  const nativeDownloadRequests=downloadFixture.values('downloads-native');
  const nativeIgnoredURL=origin.replace('127.0.0.1','localhost')+'/downloads/view?client=ignored-native&name=ignored';
  await nativePage.evaluate(url=>{const link=document.createElement('a');link.href=url;link.download='ignored.txt';document.body.append(link);link.click();},nativeIgnoredURL);
  await nativePage.waitForURL(nativeIgnoredURL);
  await nativePage.goto(origin+'/downloads/page?client=download-parent-native');
  const nativeDownloadChildAttached=nativePage.waitForEvent('frameattached');
  const nativeDownloadChildURL=origin+'/downloads/page?client=download-child-native';
  await nativePage.evaluate(url=>{const child=document.createElement('iframe');child.src=url;document.body.append(child);},nativeDownloadChildURL);
  const nativeDownloadChild=await nativeDownloadChildAttached;await nativeDownloadChild.waitForURL(nativeDownloadChildURL);
  await nativeDownloadChild.evaluate(source=>eval(source),prepare_downloads('download-child-native'));
  await nativeDownloadChild.evaluate(()=>{downloadAction='attachment';});
  const nativeChildDownloadPending=nativePage.waitForEvent('download');await nativeDownloadChild.locator('#download-trigger').click();
  const nativeChildDownload=await nativeChildDownloadPending;
  const nativeChildFile={filename:nativeChildDownload.suggestedFilename(),body:(await readFile(await nativeChildDownload.path())).toString('base64')};
  assert.equal(await nativeDownloadChild.evaluate(()=>downloadMarker),'original');
  const nativeChildDownloadRequests=downloadFixture.values('download-child-native');
  await nativePage.goto(origin+'/cache/page?client=cache-native');
  const nativeCache=JSON.parse(await nativePage.evaluate(source=>eval(source),cache_script('cache-native')));
  const nativeCacheRequests=cacheFixture.values('cache-native');
  assert.equal(nativeCache[0].body,nativeCache[1].body);assert.equal(nativeCache[3].status,200);
  await nativePage.goto(origin+'/cache/document?client=reload-native&item=document');
  assert.equal(await nativePage.evaluate(()=>documentVersion),1);cacheFixture.bump('reload-native','document');
  await nativePage.reload();assert.equal(await nativePage.evaluate(()=>documentVersion),2);
  await nativePage.goto(origin+'/keepalive/page?client=keep-native');
  const nativeKeepaliveQuota=JSON.parse(await nativePage.evaluate(source=>eval(source),keepalive_quota_script('keep-native')));
  assert.deepEqual(nativeKeepaliveQuota,{beacon:false,second:'TypeError',status:200});
  keepalive.release('keep-native','quota');
  const nativeKeepaliveFinish=JSON.parse(await nativePage.evaluate(source=>eval(source),keepalive_finish_script('keep-native')));
  await nativePage.evaluate(source=>eval(source),keepalive_abort_script('keep-native'));
  await keepalive.wait('keep-native',['abort']);
  assert.equal(await nativePage.evaluate(()=>{keepaliveAbort.abort();return keepaliveAborted;}),'AbortError');
  keepalive.release('keep-native','abort');
  await keepalive.wait('keep-native',['quota','request','abort'],true);
  const nativeKeepaliveRequests=await keepalive.values('keep-native');
  await nativePage.goto(origin+'/keepalive/page?client=unload-native');
  await nativePage.evaluate(source=>eval(source),keepalive_unload_script('unload-native'));
  await keepalive.wait('unload-native',['accepted']);
  await nativePage.goto(origin.replace('127.0.0.1','localhost')+'/keepalive/destination');
  await keepalive.wait('unload-native',['accepted','unload','form']);
  for(const name of ['accepted','unload','form'])keepalive.release('unload-native',name);
  await keepalive.wait('unload-native',['accepted','unload','form'],true);
  const nativeKeepaliveUnload=await keepalive.values('unload-native');
  await nativePage.goto(origin+'/keepalive/page?client=worker-native');
  assert.equal(await nativePage.evaluate(source=>eval(source),keepalive_worker_script('worker-native')),'started');
  await keepalive.wait('worker-native',['worker']);await nativePage.evaluate(()=>keepaliveWorker.terminate());
  keepalive.release('worker-native','worker');await keepalive.wait('worker-native',['worker'],true);
  const nativeWorkerKeepalive=await keepalive.values('worker-native');
  await nativePage.goto(origin+'/keepalive/page');
  const nativeKeepaliveChildAttached=nativePage.waitForEvent('frameattached');
  const nativeKeepaliveChildURL=origin.replace('127.0.0.1','localhost')+'/keepalive/page?client=child-keep-native';
  await nativePage.evaluate(url=>{const child=document.createElement('iframe');child.src=url;document.body.append(child);},nativeKeepaliveChildURL);
  const nativeKeepaliveChild=await nativeKeepaliveChildAttached;await nativeKeepaliveChild.waitForURL(nativeKeepaliveChildURL);
  await nativeKeepaliveChild.evaluate(source=>eval(source),keepalive_unload_script('child-keep-native'));
  await keepalive.wait('child-keep-native',['accepted']);await nativePage.goto(origin+'/keepalive/destination');
  await keepalive.wait('child-keep-native',['accepted','unload','form']);
  for(const name of ['accepted','unload','form'])keepalive.release('child-keep-native',name);
  await keepalive.wait('child-keep-native',['accepted','unload','form'],true);
  const nativeChildKeepalive=await keepalive.values('child-keep-native');
  const nativeModules=await verify_module_requests(url=>nativePage.goto(url),source=>nativePage.evaluate(source=>eval(source),source),origin,'modules-native');
  const nativeModuleHeaders=moduleRequests.profiles('modules-native');
  await nativePage.goto(origin+'/page');
  const nativeEmptyHeaders=await nativePage.evaluate(source=>eval(source),empty_headers_script(origin,'empty-native'));
  verify_empty_headers(nativeEmptyHeaders);
  console.log(JSON.stringify({transportEntries:await verify_transport_entries(nativeContext,origin,nativeEmptyHeaders)}));
  const nativeUploads=JSON.parse(await nativePage.evaluate(source=>eval(source),upload_script()));
  verify_uploads(nativeUploads);
  await nativeContext.addCookies([{url:origin.replace('127.0.0.1','localhost')+'/fonts/',name:'font_session',value:'cross',sameSite:'Lax'}]);
  await nativePage.goto(origin+'/fonts/page?client=font-native');
  const nativeFonts=JSON.parse(await nativePage.evaluate(source=>eval(source),font_script('font-native')));
  // Chromium's full-browser and shell renderers can differ by subpixel rounding.
  // Keep the native/proxy comparison exact below; only the fixture's nominal
  // 60px sanity check needs a tolerance (well below a visible layout change).
  const assertFontWidth=width=>assert.ok(Math.abs(width-60)<0.001,'Fixture font width differs from 60px: '+width);
  assert.deepEqual(nativeFonts.map(value=>[value.count,value.status]),Array.from({length:6},()=>[1,'loaded']));
  for(const value of nativeFonts)assertFontWidth(value.width);
  const nativeFontRequests=fonts.values('font-native');
  assert.equal(nativeFontRequests.length,6);
  await nativePage.goto(origin+'/fonts/page?client=constructor-native');
  const nativeConstructorFonts=JSON.parse(await nativePage.evaluate(source=>eval(source),constructor_font_script('constructor-native')));
  assert.equal(nativeConstructorFonts.lazy,'unloaded');assertFontWidth(nativeConstructorFonts.width);assertFontWidth(nativeConstructorFonts.automatic.width);
  const {width:workerFontWidth,...workerFontState}=nativeConstructorFonts.worker;
  assertFontWidth(workerFontWidth);
  assert.deepEqual(workerFontState,{status:'loaded',has:true,identity:true});
  const nativeConstructorRequests=fonts.values('constructor-native').filter(value=>value.path.includes('/ctor-'));
  const nativeCSS=new Map();
  for(const policy of ['', 'unsafe-url', 'no-referrer', 'link-no-referrer']){
    const client='css-native-'+policy;
    await nativePage.goto(origin+'/css-context/page?client='+client+'&policy='+policy);
    assert.equal(await nativePage.evaluate(source=>eval(source),cssEditScript(client)),'19px');
    await waitCSS(client);nativeCSS.set(policy,cssValues(client));
  }
  await nativeContext.addCookies([{url:origin.replace('127.0.0.1','localhost'),name:'ctx_target_strict',value:'s',sameSite:'Strict'},{url:origin.replace('127.0.0.1','localhost'),name:'ctx_target_lax',value:'l',sameSite:'Lax'}]);
  await nativePage.goto(origin.replace('127.0.0.1','localhost')+'/request-context/source');
  for(const [label,method,cross,policy] of formCases){
    await nativePage.goto(origin+'/request-context/source?policy='+policy);
    await nativePage.evaluate(source=>eval(source),submitFormScript('forms-native',label,method,cross?origin.replace('127.0.0.1','localhost'):origin));
    await nativePage.waitForURL(url=>url.pathname==='/request-context/echo'&&url.searchParams.get('label')===label);
  }
  const nativeFormContexts=contextValues('forms-native');
  await nativePage.goto(origin+'/request-context/source?policy=origin');
  const nativeChildAttached=nativePage.waitForEvent('frameattached');
  await nativePage.evaluate(url=>{const child=document.createElement('iframe');child.src=url;document.body.append(child);},origin.replace('127.0.0.1','localhost')+'/request-context/source?policy=origin');
  const nativeChild=await nativeChildAttached;await nativeChild.waitForURL(url=>url.pathname==='/request-context/source');
  const nativeChildReferrer=await nativeChild.evaluate(()=>document.referrer);
  await nativeChild.evaluate(source=>eval(source),submitFormScript('child-form-native','child','POST',origin));
  await nativeChild.waitForURL(url=>url.pathname==='/request-context/echo');
  const nativeChildContext=contextValues('child-form-native');
  await nativeContext.close();
  for(const storageDenied of [false,true]){
  const client='proxy-'+storageDenied,workerClient='worker-'+storageDenied;
  const context=await browser.newContext();
  if(storageDenied)await context.addInitScript(()=>{
    Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Storage denied','SecurityError');}});
    Object.defineProperty(window,'indexedDB',{get(){throw new DOMException('Storage denied','SecurityError');}});
    Object.defineProperty(window,'caches',{configurable:true,get(){throw new DOMException('Storage denied','SecurityError');}});
  });
  const page=await context.newPage();
  const direct=[],errors=[];
  page.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{
    // This fixture deliberately delivers a comma-separated meta policy. Its
    // native validation diagnostic is expected; script/runtime errors are not.
    if(message.type()==='error'&&!message.text().startsWith('Failed to set referrer policy: A policy specified by a meta element must contain only one token.'))errors.push(message.text());
  });
  await page.goto(pathToFileURL(fileURLToPath(new URL('../example/bundled.html',import.meta.url))).href);
  await page.waitForFunction(()=>globalThis.main_frame&&!main_frame.is_navigating);
  await page.evaluate(async origin=>{
    sandstone.network.set_websocket(origin.replace('http:','ws:')+'/');main_frame.on_load=()=>{};
    main_frame.special_pages[origin+'/page']='<!doctype html><body>Relay SSE fixture</body>';
    await main_frame.navigate_to(origin+'/page');
  },origin);
  const authResult=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),authenticatedScript));
  assert.deepEqual(authResult,authBaseline,'WebSocket login/handshake cookie behavior differs from the native browser');
  const reflectedAuthScript=authenticatedScript.replace('new WebSocket(', 'new (Object.getOwnPropertyDescriptor(globalThis,"WebSocket").value)(');
  const reflectedAuth=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),reflectedAuthScript));
  assert.deepEqual(reflectedAuth,authBaseline,'Reflected WebSocket bypassed virtual authentication or the relay');
  assert.deepEqual(await page.evaluate(source=>main_frame.eval_js(source),opaqueSocketScript),opaqueSocketBaseline,'Opaque frame WebSocket origins or SameSite cookies differ from native Chromium');
  const beaconClient='beacon-'+storageDenied;
  const beaconResult=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),beaconScript(beaconClient)));
  assert.deepEqual(beaconResult,beaconBaseline,'sendBeacon synchronous behavior differs from native Chromium');
  await waitBeacons(beaconClient,6);
  assert.deepEqual(await beaconBodies(beaconClient),nativeBeaconBodies,'Beacon payloads differ from native Chromium');
  await page.evaluate(origin=>main_frame.navigate_to(origin+'/request-context/source?policy=origin#fragment'),origin);
  const contextClient='context-'+storageDenied;
  const actualContext=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),contextScript(contextClient)));
  assert.deepEqual(actualContext,nativeContextResult);
  assert.deepEqual(contextValues(contextClient),nativeRequestContexts,'Origin/referrer/cookie headers differ from native Chromium');
  assert.deepEqual(await verify_cookie_storage(url=>page.evaluate(url=>main_frame.navigate_to(url),url),source=>page.evaluate(source=>main_frame.eval_js(source),source),origin),nativeCookieStorage,'Stored cookie visibility differs from native Chromium');
  assert.deepEqual(await verify_embedded_cookies(page,url=>page.evaluate(url=>main_frame.navigate_to(url),url),source=>page.evaluate(source=>main_frame.eval_js(source),source),origin,true),nativeEmbeddedCookies,'Embedded cookie visibility differs from native Chromium');
  const metaClient='declared-meta-'+storageDenied;
  await page.evaluate(url=>main_frame.navigate_to(url),origin+'/request-context/source?policy=origin&meta=no-referrer&script='+metaClient);
  assert.deepEqual(contextValues(metaClient),nativeDeclaredMeta,'Declared meta policy was ignored during initial script downloads');
  const downloadClient='downloads-'+storageDenied;
  await page.evaluate(url=>main_frame.navigate_to(url),origin+'/downloads/page?client='+downloadClient);
  const actualDownloads=await verify_downloads(page,source=>page.evaluate(source=>main_frame.eval_js(source),source),downloadClient,()=>page.frameLocator('iframe[frame-id]').locator('#download-trigger').click());
  assert.deepEqual(actualDownloads,nativeDownloads,'Relayed download filenames or contents differ from native Chromium');
  assert.deepEqual(downloadFixture.values(downloadClient),nativeDownloadRequests,'Download cookies, referrers, redirects or network requests differ from native Chromium');
  assert.equal(await page.evaluate(()=>main_frame.eval_js('downloadMarker')),'original');
  const ignoredURL=origin.replace('127.0.0.1','localhost')+'/downloads/view?client=ignored-'+storageDenied+'&name=ignored';
  await page.evaluate(url=>main_frame.eval_js('const ignored=document.createElement("a");ignored.href='+JSON.stringify(url)+';ignored.download="ignored.txt";document.body.append(ignored);ignored.click();true'),ignoredURL);
  await page.waitForFunction(url=>!main_frame.is_navigating&&main_frame.url.href===url,ignoredURL);
  assert.equal(await page.evaluate(()=>main_frame.eval_js('Boolean(document.getElementById("cross-view"))')),true,'Cross-origin download attribute prevented ordinary navigation');
  await page.evaluate(url=>main_frame.navigate_to(url),origin+'/downloads/page?client=download-parent-'+storageDenied);
  const childDownloadClient='download-child-'+storageDenied,childDownloadURL=origin+'/downloads/page?client='+childDownloadClient;
  await page.evaluate(url=>main_frame.eval_js('const child=document.createElement("iframe");child.src='+JSON.stringify(url)+';document.body.append(child);true'),childDownloadURL);
  let downloadChild;const downloadChildDeadline=Date.now()+10000;
  while(!downloadChild&&Date.now()<downloadChildDeadline){
    for(const frame of page.frames())if(await frame.evaluate(url=>globalThis.sandstone_frame?.loader.url===url&&sandstone_frame.loader.ready_state==='complete',childDownloadURL).catch(()=>false)){downloadChild=frame;break;}
    if(!downloadChild)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(downloadChild,'Nested download fixture did not load');
  await downloadChild.evaluate(source=>sandstone_frame.context.run_script(source),prepare_downloads(childDownloadClient));
  await downloadChild.evaluate(()=>sandstone_frame.context.run_script('downloadAction="attachment";true'));
  const childDownloadPending=page.waitForEvent('download');await downloadChild.locator('#download-trigger').click();
  const childDownload=await childDownloadPending;
  assert.deepEqual({filename:childDownload.suggestedFilename(),body:(await readFile(await childDownload.path())).toString('base64')},nativeChildFile);
  assert.equal(await downloadChild.evaluate(()=>sandstone_frame.context.run_script('downloadMarker')),'original','An iframe attachment replaced the original child document');
  assert.deepEqual(downloadFixture.values(childDownloadClient),nativeChildDownloadRequests,'Nested attachment download used the wrong document headers');
  const cacheClient='cache-'+storageDenied;
  await page.evaluate(url=>main_frame.navigate_to(url),origin+'/cache/page?client='+cacheClient);
  const actualCache=JSON.parse(await page.evaluate(async source=>{
    let timer;
    try{return await Promise.race([main_frame.eval_js(source),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('HTTP cache fixture timed out')),15000);})]);}
    finally{clearTimeout(timer);}
  },cache_script(cacheClient)));
  assert.deepEqual(actualCache,nativeCache,'HTTP cache response bodies, validators, modes or HEAD handling differ from native Chromium');
  const actualCacheRequests=cacheFixture.values(cacheClient);
  // HTTP permits retaining multiple Vary representations and cached HEAD
  // metadata. Chromium evicts those more aggressively; response parity above
  // covers them, and the remaining requests compare exact cache behavior.
  const comparableCacheRequests=values=>values.filter(value=>!['vary','head'].includes(value.item));
  assert.deepEqual(comparableCacheRequests(actualCacheRequests),comparableCacheRequests(nativeCacheRequests),'HTTP cache request reuse or conditional headers differ from native Chromium');
  assert.equal(actualCacheRequests.filter(value=>value.item==='vary').length,2,'Matching Vary representations were fetched repeatedly');
  const reloadClient='reload-'+storageDenied;
  await page.evaluate(url=>main_frame.navigate_to(url),origin+'/cache/document?client='+reloadClient+'&item=document');
  assert.equal(await page.evaluate(()=>main_frame.eval_js('documentVersion')),1);cacheFixture.bump(reloadClient,'document');
  const reloadNavigation=await page.evaluate(()=>{const id=main_frame.navigation_id;main_frame.eval_js('location.reload();true').catch(()=>{});return id;});
  await page.waitForFunction(id=>main_frame.navigation_id>id&&!main_frame.is_navigating,reloadNavigation);
  assert.equal(await page.evaluate(()=>main_frame.eval_js('documentVersion')),2,'location.reload reused a fresh cached document');
  assert.equal(cacheFixture.values(reloadClient)[1].cache,'max-age=0');
  const keepClient='keep-'+storageDenied;
  await page.evaluate(url=>main_frame.navigate_to(url),origin+'/keepalive/page?client='+keepClient);
  const actualKeepaliveQuota=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),keepalive_quota_script(keepClient)));
  assert.deepEqual(actualKeepaliveQuota,nativeKeepaliveQuota,'Fetch/beacon keepalive quota differs from native Chromium');
  keepalive.release(keepClient,'quota');
  const actualKeepaliveFinish=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),keepalive_finish_script(keepClient)));
  assert.deepEqual(actualKeepaliveFinish,nativeKeepaliveFinish,'Keepalive response/Request/validation behavior differs from native Chromium');
  await page.evaluate(source=>main_frame.eval_js(source),keepalive_abort_script(keepClient));
  await keepalive.wait(keepClient,['abort']);
  assert.equal(await page.evaluate(()=>main_frame.eval_js('keepaliveAbort.abort();keepaliveAborted')),'AbortError');
  keepalive.release(keepClient,'abort');
  await keepalive.wait(keepClient,['quota','request','abort'],true);
  assert.deepEqual(await keepalive.values(keepClient),nativeKeepaliveRequests,'Keepalive request headers, body or cancellation differ from native Chromium');
  const keepUnloadClient='keep-unload-'+storageDenied;
  await page.evaluate(url=>main_frame.navigate_to(url),origin+'/keepalive/page?client='+keepUnloadClient);
  await page.evaluate(source=>main_frame.eval_js(source),keepalive_unload_script(keepUnloadClient));
  await keepalive.wait(keepUnloadClient,['accepted']);
  await page.evaluate(url=>main_frame.navigate_to(url),origin.replace('127.0.0.1','localhost')+'/keepalive/destination');
  await keepalive.wait(keepUnloadClient,['accepted','unload','form']);
  for(const name of ['accepted','unload','form'])keepalive.release(keepUnloadClient,name);
  await keepalive.wait(keepUnloadClient,['accepted','unload','form'],true);
  assert.deepEqual(await keepalive.values(keepUnloadClient),nativeKeepaliveUnload,'Keepalive requests did not survive navigation with their original payloads and document headers');
  const workerKeepClient='worker-keep-'+storageDenied;
  await page.evaluate(url=>main_frame.navigate_to(url),origin+'/keepalive/page?client='+workerKeepClient);
  assert.equal(await page.evaluate(source=>main_frame.eval_js(source),keepalive_worker_script(workerKeepClient)),'started');
  await keepalive.wait(workerKeepClient,['worker']);await page.evaluate(()=>main_frame.eval_js('keepaliveWorker.terminate();true'));
  keepalive.release(workerKeepClient,'worker');await keepalive.wait(workerKeepClient,['worker'],true);
  assert.deepEqual(await keepalive.values(workerKeepClient),nativeWorkerKeepalive,'Keepalive requests did not retain their worker context after termination');
  await page.evaluate(url=>main_frame.navigate_to(url),origin+'/keepalive/page');
  const childKeepClient='child-keep-'+storageDenied;
  const childKeepURL=origin.replace('127.0.0.1','localhost')+'/keepalive/page?client='+childKeepClient;
  await page.evaluate(url=>main_frame.eval_js('const child=document.createElement("iframe");child.src='+JSON.stringify(url)+';document.body.append(child);true'),childKeepURL);
  let keepChild;const keepChildDeadline=Date.now()+10000;
  while(!keepChild&&Date.now()<keepChildDeadline){
    for(const frame of page.frames())if(await frame.evaluate(url=>globalThis.sandstone_frame?.loader.url===url&&sandstone_frame.loader.ready_state==='complete',childKeepURL).catch(()=>false)){keepChild=frame;break;}
    if(!keepChild)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(keepChild,'Nested keepalive fixture did not load');
  await keepChild.evaluate(source=>sandstone_frame.context.run_script(source),keepalive_unload_script(childKeepClient));
  await keepalive.wait(childKeepClient,['accepted']);await page.evaluate(url=>main_frame.navigate_to(url),origin+'/keepalive/destination');
  await keepalive.wait(childKeepClient,['accepted','unload','form']);
  for(const name of ['accepted','unload','form'])keepalive.release(childKeepClient,name);
  await keepalive.wait(childKeepClient,['accepted','unload','form'],true);
  assert.deepEqual(await keepalive.values(childKeepClient),nativeChildKeepalive,'Nested keepalive requests lost their child document context during navigation');
  await page.evaluate(origin=>sandstone.controller.site_data.setCookie(origin.replace('127.0.0.1','localhost')+'/fonts/','font_session=cross; SameSite=Lax; Path=/fonts/'),origin);
  const moduleClient='modules-'+storageDenied;
  assert.deepEqual(await verify_module_requests(url=>page.evaluate(url=>main_frame.navigate_to(url),url),source=>page.evaluate(source=>main_frame.eval_js(source),source),origin,moduleClient),nativeModules,'Negotiated module representations differ from native Chromium');
  assert.deepEqual(moduleRequests.profiles(moduleClient),nativeModuleHeaders,'JSON/CSS module Accept, Origin or referrer headers differ from native Chromium');
  await page.evaluate(url=>main_frame.navigate_to(url),origin+'/page');
  const emptyHeaders=await page.evaluate(source=>main_frame.eval_js(source),empty_headers_script(origin,'empty-'+storageDenied));
  verify_empty_headers(emptyHeaders);
  assert.deepEqual(emptyHeaders,nativeEmptyHeaders,'Explicit empty request headers differ from native Fetch/XHR');
  await verify_relay_uploads(page,origin,nativeUploads);
  const fontClient='font-'+storageDenied;
  await page.evaluate(url=>main_frame.navigate_to(url),origin+'/fonts/page?client='+fontClient);
  const actualFonts=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),font_script(fontClient)));
  assert.deepEqual(actualFonts,nativeFonts,'Relayed CSS fonts did not load and render like native fonts');
  assert.deepEqual(fonts.values(fontClient),nativeFontRequests,'CSS font Origin/referrer/cookie headers differ from native Chromium');
  const constructorClient='constructor-'+storageDenied;
  await page.evaluate(url=>main_frame.navigate_to(url),origin+'/fonts/page?client='+constructorClient);
  const actualConstructorFonts=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),constructor_font_script(constructorClient)));
  assert.deepEqual(actualConstructorFonts,nativeConstructorFonts,'FontFace loading, membership, rendering or events differ from native Chromium');
  assert.deepEqual(fonts.values(constructorClient).filter(value=>value.path.includes('/ctor-')),nativeConstructorRequests,'FontFace request headers differ from native Chromium');
  for(const policy of ['', 'unsafe-url', 'no-referrer', 'link-no-referrer']){
    const client='css-'+storageDenied+'-'+policy;
    await page.evaluate(url=>main_frame.navigate_to(url),origin+'/css-context/page?client='+client+'&policy='+policy);
    assert.equal(await page.evaluate(source=>main_frame.eval_js(source),cssEditScript(client)),'19px');
    await waitCSS(client);
    assert.deepEqual(cssValues(client),nativeCSS.get(policy),'External stylesheet/import/CSSOM referrers differ from native Chromium');
  }
  await page.evaluate(origin=>{
    for(const cookie of ['ctx_target_strict=s; SameSite=Strict; Path=/','ctx_target_lax=l; SameSite=Lax; Path=/'])sandstone.controller.site_data.setCookie(origin.replace('127.0.0.1','localhost')+'/',cookie);
  },origin);
  const formClient='forms-'+storageDenied;
  await page.evaluate(url=>main_frame.navigate_to(url),origin.replace('127.0.0.1','localhost')+'/request-context/source');
  for(const [label,method,cross,policy] of formCases){
    await page.evaluate(url=>main_frame.navigate_to(url),origin+'/request-context/source?policy='+policy);
    await page.evaluate(source=>main_frame.eval_js(source),submitFormScript(formClient,label,method,cross?origin.replace('127.0.0.1','localhost'):origin));
    await page.waitForFunction(label=>!main_frame.is_navigating&&main_frame.url.pathname==='/request-context/echo'&&main_frame.url.searchParams.get('label')===label,label);
    assert.equal(await page.evaluate(()=>main_frame.eval_js('document.referrer')),nativeFormContexts.find(value=>value.label===label).referrer||'','Virtual document.referrer differs from the navigation referrer');
  }
  assert.deepEqual(contextValues(formClient),nativeFormContexts,'Form submission Origin/referrer/SameSite cookies differ from native Chromium');
  await page.evaluate(url=>main_frame.navigate_to(url),origin+'/request-context/source?policy=origin');
  const childSource=origin.replace('127.0.0.1','localhost')+'/request-context/source?policy=origin';
  await page.evaluate(url=>main_frame.eval_js('const child=document.createElement("iframe");child.src='+JSON.stringify(url)+';document.body.append(child);true'),childSource);
  let virtualChild;
  const childDeadline=Date.now()+10000;
  while(!virtualChild&&Date.now()<childDeadline){
    for(const frame of page.frames())if(await frame.evaluate(url=>globalThis.sandstone_frame?.loader.url===url&&sandstone_frame.loader.ready_state==='complete',childSource).catch(()=>false)){virtualChild=frame;break;}
    if(!virtualChild)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(virtualChild,'Nested request-context fixture did not load');
  assert.equal(await virtualChild.evaluate(()=>sandstone_frame.context.run_script('document.referrer')),nativeChildReferrer);
  const childFormClient='child-form-'+storageDenied;
  await virtualChild.evaluate(source=>sandstone_frame.context.run_script(source),submitFormScript(childFormClient,'child','POST',origin));
  const childSubmitDeadline=Date.now()+10000;
  while(!contextValues(childFormClient).length){if(Date.now()>childSubmitDeadline)throw new Error('Nested form did not reach the relay');await new Promise(resolve=>setTimeout(resolve,10));}
  assert.deepEqual(contextValues(childFormClient),nativeChildContext,'Nested form used its parent or destination as the initiating origin');
  await page.evaluate(origin=>main_frame.navigate_to(origin+'/page'),origin);
  const echoed=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),websocketScript));
  assert.deepEqual(echoed,{values:[[98,108,111,98,32,102,105,114,115,116],'text second',[2,3],'last'],state:3,buffered:0});
  const workerEcho=JSON.parse(await page.evaluate(source=>main_frame.eval_js(`new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(new Blob(['onmessage=async()=>postMessage(await ('+${JSON.stringify(source)}+'));'],{type:'text/javascript'}));
    const worker=new Worker(url);
    worker.onmessage=event=>{worker.terminate();URL.revokeObjectURL(url);resolve(event.data);};
    worker.onerror=event=>{event.preventDefault();reject(new Error(event.message));};worker.postMessage('start');
  })`),websocketScript));
  assert.deepEqual(workerEcho,echoed);
  const workerAuth=await page.evaluate(origin=>main_frame.eval_js(`new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(new Blob(['onmessage=()=>{const socket=new WebSocket('+${JSON.stringify(JSON.stringify(origin.replace('http:','ws:')+'/ws-auth'))}+');socket.onopen=()=>socket.close();socket.onerror=()=>postMessage(false);socket.onclose=()=>postMessage(true);};'],{type:'text/javascript'}));
    const worker=new Worker(url);worker.onmessage=event=>{worker.terminate();URL.revokeObjectURL(url);resolve(event.data);};worker.onerror=event=>{event.preventDefault();reject(new Error(event.message));};worker.postMessage('start');
  })`),origin);
  assert.equal(workerAuth,true,'Blob worker did not inherit the authenticated page origin');
  const lastAuth=authRequests.at(-1);
  assert.equal(lastAuth.origin,origin);assert.ok(lastAuth.cookie.includes('auth_session=token'));
  assert.ok(!lastAuth.cookie.includes('auth_wrong='));assert.ok(!lastAuth.cookie.includes('auth_expired='));
  const serverClosed=await page.evaluate(origin=>main_frame.eval_js(`new Promise(resolve=>{
    const socket=new WebSocket(${JSON.stringify(origin.replace('http:','ws:')+'/ws-close')},['second']);
    socket.onclose=()=>resolve(socket.readyState);
  })`),origin);
  assert.equal(serverClosed,3);
  const pendingSocket=once(server,'ws-pending',{signal:AbortSignal.timeout(5000)});
  await page.evaluate(origin=>main_frame.eval_js(`window.pendingSocket=new WebSocket(${JSON.stringify(origin.replace('http:','ws:')+'/ws-pending')}); true`),origin);
  const [heldSocket]=await pendingSocket;
  const socketCancelled=once(heldSocket,'close',{signal:AbortSignal.timeout(5000)});
  heldSocket.on('end',()=>heldSocket.end());
  heldSocket.resume();
  const cancelledStates=await page.evaluate(()=>main_frame.eval_js(`new Promise(resolve=>{const states=[];pendingSocket.onerror=()=>states.push('error');pendingSocket.onclose=()=>resolve(JSON.stringify([...states,pendingSocket.readyState]));pendingSocket.close();})`));
  await socketCancelled;assert.deepEqual(JSON.parse(cancelledStates),['error',3]);
  const refused=await page.evaluate(origin=>main_frame.eval_js(`new Promise(resolve=>{const states=[];const socket=new WebSocket(${JSON.stringify(origin.replace('http:','ws:')+'/ws-refused')});socket.onerror=()=>states.push('error');socket.onclose=()=>resolve(JSON.stringify([...states,socket.readyState]));})`),origin);
  assert.deepEqual(JSON.parse(refused),['error',3]);
  assert.ok(await page.evaluate(()=>main_frame.eval_js(`document.cookie.split('; ').includes('refused=visible')`)), 'Failed handshake cookies were discarded');
  assert.equal(await page.evaluate(()=>Object.values(sandstone.network.ws_connections).flatMap(Object.values).length),0);
  const proxied=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),sourceScript(client,true)).catch(async error=>{
    console.error(JSON.stringify({requests,errors}));throw error;
  }));
  assert.deepEqual(proxied,baseline,'Relayed EventSource events differ from native EventSource');
  const lifecycleSource=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),sourceScript('lifecycle-'+storageDenied,false,true)));
  assert.deepEqual(lifecycleSource,lifecycleBaseline,'Synthetic unload events closed a relayed EventSource');
  const retainedStream=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),streamLifecycleScript('retained-'+storageDenied)));
  assert.deepEqual(retainedStream,retainedStreamBaseline,'Native unload failed to close a retained event stream after synthetic unload');
  for(const name of ['native',client]){
    const values=requests.filter(value=>value.client===name);
    assert.deepEqual(values.map(value=>value.id),['','漢字-€','']);
    assert.ok(values[1].cookie.includes('stream=visible'));
    if(name===client)assert.ok(values[0].cookie.includes('redirect=visible'));
  }
  const stopped=await page.evaluate(origin=>main_frame.eval_js(`(async()=>{
    const states=[];
    for(const path of ['stop','wrong']){
      states.push(await new Promise(resolve=>{
        const source=new EventSource(${JSON.stringify(origin)}+'/'+path);source.onerror=()=>resolve(source.readyState);
      }));
    }
    return JSON.stringify(states);
  })()`),origin);
  assert.deepEqual(JSON.parse(stopped),[2,2]);
  const arrived=once(server,'pending',{signal:AbortSignal.timeout(5000)});
  await page.evaluate(origin=>main_frame.eval_js(`window.pendingSource=new EventSource(${JSON.stringify(origin+'/pending')}); true`),origin);
  const [pendingResponse]=await arrived;
  const cancelled=once(pendingResponse,'close',{signal:AbortSignal.timeout(5000)});
  await page.evaluate(()=>main_frame.eval_js('pendingSource.close(); true'));
  await cancelled;
  const workerSource=`onmessage=async()=>{postMessage(await (${sourceScript(workerClient)}));};`;
  const worker=JSON.parse(await page.evaluate(source=>main_frame.eval_js(`new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(new Blob([${JSON.stringify(source)}],{type:'text/javascript'}));
    const worker=new Worker(url);
    worker.onmessage=event=>{worker.terminate();URL.revokeObjectURL(url);resolve(event.data);};
    worker.onerror=event=>{event.preventDefault();reject(new Error(event.message));};worker.postMessage('start');
  })`),workerSource));
  assert.deepEqual(worker,baseline);
  await page.evaluate(()=>sandstone.controller.site_data.clear('127.0.0.1'));
  const cleared=await page.evaluate(origin=>main_frame.eval_js(`new Promise(resolve=>{
    const socket=new WebSocket(${JSON.stringify(origin.replace('http:','ws:')+'/ws-auth')});
    let failed=false;socket.onerror=()=>failed=true;socket.onclose=()=>resolve(JSON.stringify({failed,cookies:document.cookie}));
  })`),origin);
  assert.deepEqual(JSON.parse(cleared),{failed:true,cookies:''},'Per-site clearing did not remove WebSocket credentials');
  assert.equal(authRequests.at(-1).cookie,'');
  const heldClient='held-'+storageDenied,unloadClient='unload-'+storageDenied,childClient='child-beacon-'+storageDenied;
  await page.evaluate(({origin,heldClient,unloadClient})=>{
    sandstone.controller.site_data.setCookie(origin+'/','beacon_session=secret; HttpOnly; SameSite=Strict; Path=/');
    return main_frame.eval_js('navigator.sendBeacon('+JSON.stringify(origin+'/beacon?client='+heldClient+'&hold=1')+',"accepted before navigation");addEventListener("unload",()=>navigator.sendBeacon('+JSON.stringify(origin+'/beacon?client='+unloadClient+'&hold=1')+',"sent during unload"));true');
  },{origin,heldClient,unloadClient});
  await waitBeacons(heldClient,1);
  await page.evaluate(url=>main_frame.eval_js('const child=document.createElement("iframe");child.src='+JSON.stringify(url)+';document.body.append(child);true'),origin+'/beacon-child?client='+childClient);
  await waitBeacons(childClient,1);
  const nextOrigin=origin.replace('127.0.0.1','localhost');
  await page.evaluate(async url=>{main_frame.special_pages[url]='<!doctype html><body>Beacon navigation destination</body>';await main_frame.navigate_to(url);},nextOrigin+'/next');
  await waitBeacons(unloadClient,1);
  await waitBeacons(childClient,2);
  for(const client of [heldClient,unloadClient,childClient]){
    const value=beaconRequests.filter(value=>value.client===client).at(-1);
    assert.equal(value.origin,origin);assert.ok(value.cookie.includes('beacon_session=secret'));
    const response=heldBeacons.get(client);assert.ok(response&&!response.destroyed,'An accepted beacon was aborted by navigation');
    response.writeHead(204);response.end();heldBeacons.delete(client);
  }
  await page.waitForFunction(()=>sandstone.network.beacons.pending.size===0);
  await page.waitForFunction(()=>sandstone.network.session.active_requests===0 && sandstone.network.session.requests_list.length===0 && Object.keys(sandstone.network.session.request_callbacks).length===0);
  assert.deepEqual(direct,[],'A relayed connection made a direct HTTP request');
  assert.deepEqual(errors,[],'A relayed connection produced a browser error');
  assert.ok(closed.some(value=>value.client===client&&value.count===3));
    console.log(JSON.stringify({storageDenied,passed:['native/relay Origin and Referer parity','JavaScript/JSON/CSS module negotiation, redirects and Vary caching','explicit empty Fetch/XHR headers and request bodies','large uploads and bounded transport metadata','response/meta/request referrer policies and redirect taint','root/cross-origin iframe form headers and SameSite cookies','virtual document.referrer','native/relay beacon payload and validation parity','beacon binary snapshots and multipart files','accepted/unload/child beacons survive cross-origin navigation','WebSocket echo/protocol/binary ordering','opaque iframe WebSocket Origin and SameSite cookie parity','native/relay authenticated cookie parity','HttpOnly/path/SameSite cookie rules','worker WebSockets and server closure','WebSocket pending cancellation and handshake failure','failed handshake cookies and per-site clearing','native/relay SSE event parity','headers before body','UTF-8 IDs and reconnect headers','redirect/reconnect cookies','204 and MIME termination','abort before headers','worker SSE','synthetic lifecycle events preserve SSE reconnection','native iframe unload closes retained event streams','native request cleanup'],events:proxied,direct}));
  await context.close();
  }
}finally{
  await browser?.close();for(const timer of timers)clearTimeout(timer);for(const socket of sockets)socket.destroy();
  await new Promise(resolve=>server.close(resolve));
}
