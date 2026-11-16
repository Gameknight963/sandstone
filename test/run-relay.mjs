import {createServer} from 'node:http';
import {once} from 'node:events';
import {pathToFileURL, fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {server as wisp} from '../example/node_modules/@mercuryworkshop/wisp-js/src/entrypoints/server.mjs';

// Real libcurl/Wisp coverage, separate from the mocked transport fixtures. This
// relay binds only loopback and permits connections only to this test's port.
const held=new Map(),requests=[],closed=[],sockets=new Set(),timers=new Set();
const later=(callback,delay)=>{const timer=setTimeout(()=>{timers.delete(timer);callback();},delay);timers.add(timer);};
const server=createServer({shouldUpgradeCallback:request=>request.headers.upgrade?.toLowerCase()==='websocket'},(request,response)=>{
  const url=new URL(request.url,'http://localhost');
  const client=url.searchParams.get('client');
  if(url.pathname==='/redirect'){
    response.writeHead(302,{Location:'/events?'+url.searchParams,'Set-Cookie':'redirect=visible; Path=/'});response.end();return;
  }
  if(url.pathname==='/pending'){server.emit('pending',response);return;}
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
server.on('upgrade',(request,socket,head)=>wisp.routeRequest(request,socket,head));
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`;
wisp.options.allow_loopback_ips=true;wisp.options.port_whitelist=[server.address().port];
const channel=process.env.BROWSER_CHANNEL||'chrome';
let browser;
const sourceScript=(client,redirect=false)=>`new Promise((resolve,reject)=>{
  const events=[];
  const source=new EventSource(${JSON.stringify(origin+(redirect?'/redirect':'/events')+'?client='+client)},{withCredentials:true});
  const timeout=setTimeout(()=>{source.close();reject(new Error('SSE timed out: '+JSON.stringify(events)));},15000);
  source.onopen=()=>{events.push(['open',source.readyState]);fetch(${JSON.stringify(origin+'/release?client='+client)}).catch(reject);};
  source.onerror=()=>events.push(['error',source.readyState]);
  const message=event=>{
    events.push([event.type,event.data,event.lastEventId,event.origin]);
    if(event.data==='final'){source.close();clearTimeout(timeout);resolve(JSON.stringify(events));}
  };
  source.addEventListener('update',message);source.onmessage=message;
})`;
try{
  browser=await chromium.launch({channel:channel==='headless'?undefined:channel,headless:true});
  const nativeContext=await browser.newContext(),nativePage=await nativeContext.newPage();
  await nativePage.goto(origin);
  const baseline=JSON.parse(await nativePage.evaluate(source=>eval(source),sourceScript('native')).catch(error=>{console.error(JSON.stringify({requests,held:[...held.keys()]}));throw error;}));
  await nativeContext.close();
  for(const storageDenied of [false,true]){
  const client='proxy-'+storageDenied,workerClient='worker-'+storageDenied;
  const context=await browser.newContext();
  if(storageDenied)await context.addInitScript(()=>{
    Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Storage denied','SecurityError');}});
    Object.defineProperty(window,'indexedDB',{get(){throw new DOMException('Storage denied','SecurityError');}});
  });
  const page=await context.newPage();
  const direct=[],errors=[];
  page.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.goto(pathToFileURL(fileURLToPath(new URL('../example/bundled.html',import.meta.url))).href);
  await page.waitForFunction(()=>globalThis.main_frame&&!main_frame.is_navigating);
  await page.evaluate(async origin=>{
    sandstone.network.set_websocket(origin.replace('http:','ws:')+'/');main_frame.on_load=()=>{};
    main_frame.special_pages[origin+'/page']='<!doctype html><body>Relay SSE fixture</body>';
    await main_frame.navigate_to(origin+'/page');
  },origin);
  const proxied=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),sourceScript(client,true)).catch(async error=>{
    console.error(JSON.stringify({requests,errors}));throw error;
  }));
  assert.deepEqual(proxied,baseline,'Relayed EventSource events differ from native EventSource');
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
  await page.waitForFunction(()=>sandstone.network.session.active_requests===0 && sandstone.network.session.requests_list.length===0 && Object.keys(sandstone.network.session.request_callbacks).length===0);
  assert.deepEqual(direct,[],'A relayed EventSource made a direct HTTP request');
  assert.deepEqual(errors,[],'A relayed EventSource produced a browser error');
  assert.ok(closed.some(value=>value.client===client&&value.count===3));
  console.log(JSON.stringify({storageDenied,passed:['native/relay SSE event parity','headers before body','UTF-8 IDs and reconnect headers','redirect/reconnect cookies','204 and MIME termination','abort before headers','worker SSE','native request cleanup'],events:proxied,direct}));
  await context.close();
  }
}finally{
  await browser?.close();for(const timer of timers)clearTimeout(timer);for(const socket of sockets)socket.destroy();
  await new Promise(resolve=>server.close(resolve));
}
