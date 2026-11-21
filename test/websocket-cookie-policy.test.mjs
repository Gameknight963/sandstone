import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {CookieWebSocket,WebSocketOutbound,websocket_policy_options} from '../src/host/websocket.mjs';
import {CookiePolicyBridge,cookie_policy_handler} from '../src/host/cookie_policy_bridge.mjs';
import {SiteDataStore} from '../src/host/site_data.mjs';

const origin='https://worker.test',url='wss://worker.test/socket';
const context={url:origin+'/worker.js',userAgent:'fixture'};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(){
  const store=new SiteDataStore(),handler=cookie_policy_handler(store);
  const bridge=new CookiePolicyBridge(async message=>{await setImmediate();return handler(message);});
  return {store,bridge};
}

test('Async WebSocket policy preserves HttpOnly, path, Secure and cross-site SameSite cookie rules',async()=>{
  const {store,bridge}=fixture();
  for(const cookie of ['session=secret; HttpOnly; Secure; SameSite=None; Path=/','strict=blocked; SameSite=Strict; Path=/','path=hidden; Path=/private'])store.setCookie(origin,cookie,true);
  const same=await websocket_policy_options(bridge,url,context);
  assert.equal(same.headers.Cookie,'session=secret; strict=blocked');assert.equal(same.headers.Origin,origin);
  const cross=await websocket_policy_options(bridge,url,{...context,top_url:'https://other.test/page'});
  assert.equal(cross.headers.Cookie,'session=secret');
  cross.onHeader('set-cookie','remote=accepted; HttpOnly; Secure; SameSite=None; Path=/');
  cross.onHeader('set-cookie','lax=refused; SameSite=Lax; Path=/');
  await cross.cookiesReady();assert.equal(store.cookies.getCookieStringSync(origin),'session=secret; strict=blocked; remote=accepted');
});

test('Clearing site data during a WebSocket handshake rejects delayed writes and deletions',async()=>{
  const {store,bridge}=fixture();store.setCookie(origin,'session=secret; Path=/',true);
  const options=await websocket_policy_options(bridge,url,context);
  store.clear('worker.test',{cookies:true,localStorage:false});store.setCookie(origin,'fresh=after; Path=/',true);
  options.onHeader('set-cookie','session=restored; Path=/');options.onHeader('set-cookie','fresh=deleted; Max-Age=0; Path=/');
  await options.cookiesReady();assert.equal(store.cookies.getCookieStringSync(origin),'fresh=after');
});

test('WebSocket open, messages and closure wait for handshake cookie writes in native event order',async()=>{
  const held=deferred(),created=deferred(),events=[],writes=[];let native;
  const store={captureCookieContext:async()=>({cookieGeneration:7}),cookieHeader:async()=>'',setCookie:async(url,value)=>{writes.push(value);await held.promise;}};
  class Transport{
    constructor(url,protocols,options){native=this;this.options=options;this.connected=true;this.protocol='selected';created.resolve();}
    abort(){this.connected=false;}
  }
  const socket=new CookieWebSocket(Transport,store,url,[],context);
  for(const type of ['open','message','close','error'])socket['on'+type]=data=>events.push([type,data]);
  await created.promise;await setImmediate();
  native.options.onHeader('set-cookie','first=1');native.options.onHeader('set-cookie','second=2');
  native.onopen();native.onmessage('one');native.onclose({code:1000});
  await setImmediate();assert.deepEqual(events,[]);assert.deepEqual(writes,['first=1']);
  held.resolve();await socket.events;
  assert.deepEqual(writes,['first=1','second=2']);assert.deepEqual(events.map(value=>value[0]),['open','message','close']);assert.equal(socket.protocol,'selected');
});

test('Retiring a WebSocket while its cookie provider is pending never creates a native socket',async()=>{
  const entered=deferred(),held=deferred();let created=0,errors=0;
  const store=new CookiePolicyBridge(()=>{entered.resolve();return held.promise;});
  const socket=new CookieWebSocket(class{constructor(){created++;}},store,url,[],context);socket.onerror=()=>errors++;
  await entered.promise;await new WebSocketOutbound(socket).retire();held.reject(new Error('Late provider failure'));await setImmediate();
  assert.equal(created,0);assert.equal(errors,0);assert.equal(socket.controller.signal.aborted,true);
});

test('A failed cookie commit exposes one connection error and aborts the underlying socket',async()=>{
  const created=deferred();let native,aborted=0,errors=0,opened=0;
  const store={captureCookieContext:async()=>({}),cookieHeader:async()=>'',setCookie:async()=>{throw new Error('Lost provider');}};
  class Transport{constructor(url,protocols,options){native=this;this.options=options;created.resolve();}abort(){aborted++;}}
  const socket=new CookieWebSocket(Transport,store,url,[],context);socket.onerror=()=>errors++;socket.onopen=()=>opened++;
  await created.promise;await setImmediate();native.options.onHeader('set-cookie','session=secret');native.onopen();native.onmessage('unobservable');
  await socket.events;assert.equal(aborted,1);assert.equal(errors,1);assert.equal(opened,0);
});

test('Cookies from a refused HTTP handshake commit before the WebSocket error event',async()=>{
  const {store,bridge}=fixture(),created=deferred();let native,received;
  class Transport{constructor(url,protocols,options){native=this;this.options=options;created.resolve();}abort(){}}
  const socket=new CookieWebSocket(Transport,bridge,url,[],context);
  socket.onerror=()=>{received=store.cookies.getCookieStringSync(origin);};
  await created.promise;await setImmediate();native.options.onHeader('set-cookie','refused=kept; HttpOnly; Path=/');native.onerror(1);
  await socket.events;assert.equal(received,'refused=kept');
});

test('Closing while accepted handshake cookies are pending retains their writes without delivering late events',async()=>{
  const created=deferred(),held=deferred(),store=new SiteDataStore(),handle=cookie_policy_handler(store);let native,events=0;
  const bridge=new CookiePolicyBridge(async message=>{if(message.op==='set')await held.promise;return handle(message);});
  class Transport{constructor(url,protocols,options){native=this;this.options=options;created.resolve();}abort(){}}
  const socket=new CookieWebSocket(Transport,bridge,url,[],context);
  socket.onopen=socket.onclose=socket.onerror=()=>events++;
  await created.promise;await setImmediate();native.options.onHeader('set-cookie','first=kept; HttpOnly; Path=/');native.options.onHeader('set-cookie','second=kept; HttpOnly; Path=/');native.onopen();
  await setImmediate();socket.abort();held.resolve();await socket.events;
  assert.equal(store.cookies.getCookieStringSync(origin),'first=kept; second=kept');assert.equal(events,0);
});
