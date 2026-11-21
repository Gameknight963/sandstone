import test from 'node:test';
import assert from 'node:assert/strict';
import {create_websocket_class} from '../src/frame/websocket.mjs';
import {relay_websocket_class, websocket_options} from '../src/host/websocket.mjs';
import {SiteDataStore} from '../src/host/site_data.mjs';

globalThis.CloseEvent ||= class CloseEvent extends Event {
  constructor(type, options) { super(type); Object.assign(this, options); }
};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(extra = {}) {
  let wake;
  const sent = [], closed = [];
  const WS = create_websocket_class({base: () => 'https://site.test/base/',
    connect: async () => 1, events: () => new Promise(resolve => { wake = resolve; }),
    send: async (id, data) => sent.push(data), close: async (id,code,reason,abort) => {
      closed.push(id);
      if(!abort)queueMicrotask(()=>wake([['close',{code:code??1005,reason:reason||'',wasClean:true}]]));
    }, ...extra});
  return {WS, sent, closed, emit: batch => wake(batch)};
}

test('WebSocket validates URLs and protocol tokens before connecting', () => {
  const {WS} = fixture();
  for (const url of ['ftp://site.test', 'wss://site.test/#', 'wss://site.test/#fragment'])
    assert.throws(() => new WS(url), {name: 'SyntaxError'});
  for (const protocols of [['same', 'same'], [''], ['bad token'], ['bad,token']])
    assert.throws(() => new WS('/socket', protocols), {name: 'SyntaxError'});
  assert.equal(WS.OPEN, 1);
});

test('WebSocket queues Blobs and snapshots binary views in send order', async () => {
  const {WS, emit, sent, closed} = fixture();
  const socket = new WS('../socket');
  assert.equal(socket.url, 'wss://site.test/socket');
  assert.throws(() => socket.send('early'), {name: 'InvalidStateError'});
  await tick(); emit([['open', {protocol: 'selected'}]]); await tick();
  assert.equal(socket.protocol, 'selected');
  let release;
  const blob = new Blob(['first']);
  blob.arrayBuffer = () => new Promise(resolve => { release = resolve; });
  socket.send(blob); socket.send('second');
  const bytes = new Uint8Array([0, 2, 3, 0]);
  socket.send(new DataView(bytes.buffer, 1, 2)); bytes.fill(9);
  assert.equal(socket.bufferedAmount, 13);
  await tick(); assert.deepEqual(sent, []);
  socket.close();
  release(new TextEncoder().encode('first').buffer);
  await tick(); await tick();
  assert.deepEqual(sent.map(value => typeof value === 'string' ? value : [...value]), [[102,105,114,115,116], 'second', [2,3]]);
  assert.equal(socket.bufferedAmount, 0); assert.deepEqual(closed, [1]);
  assert.equal(socket.readyState, WS.CLOSED);
});

test('WebSocket handlers preserve listener order, receiver and binary events', async () => {
  const {WS, emit} = fixture();
  const socket = new WS('/socket');
  const seen = [];
  socket.addEventListener('open', () => seen.push('first'));
  socket.onopen = function(event) { assert.equal(this, socket); assert.equal(event.target, socket); seen.push('handler'); };
  socket.addEventListener('open', () => seen.push('last'));
  await tick(); emit([['open', {}]]); await tick();
  assert.deepEqual(seen, ['first', 'handler', 'last']);
  socket.binaryType = 'arraybuffer'; socket.binaryType = 'invalid';
  const incoming = new Promise(resolve => socket.onmessage = resolve);
  emit([['message', new Uint8Array([4,5])]]);
  const event = await incoming;
  assert.equal(event.origin, 'wss://site.test'); assert.deepEqual([...new Uint8Array(event.data)], [4,5]);
  socket.close(); await tick();
});

test('Closing during connection cancels the eventual host socket exactly once', async () => {
  let resolve;
  const {WS, closed} = fixture({connect: () => new Promise(value => { resolve = value; })});
  const socket = new WS('/socket');
  assert.throws(() => socket.close(1001), {name: 'InvalidAccessError'});
  assert.throws(() => socket.close(1000, '€'.repeat(42)), {name: 'SyntaxError'});
  const events = [];
  socket.onerror = () => events.push('error'); socket.onclose = () => events.push('close');
  socket.close(); socket.close(); resolve(17); await tick();
  assert.deepEqual(closed, [17]); assert.deepEqual(events, ['error', 'close']);
  assert.equal(socket.readyState, WS.CLOSED);
});

test('WebSocket close waits for the handshake and preserves received codes and Unicode reasons',async()=>{
  const calls=[],{WS,emit}=fixture({close:async(...args)=>calls.push(args)}),socket=new WS('/socket');
  await tick();emit([['open',{}]]);await tick();
  const events=[];socket.onerror=()=>events.push('error');socket.onclose=event=>events.push({code:event.code,reason:event.reason,wasClean:event.wasClean});
  socket.close(4002,'client \u20ac');await tick();
  assert.equal(socket.readyState,WS.CLOSING);assert.deepEqual(calls,[[1,4002,'client \u20ac',false]]);assert.deepEqual(events,[]);
  emit([['close',{code:4002,reason:'client \u20ac',wasClean:true}]]);await tick();
  assert.equal(socket.readyState,WS.CLOSED);assert.deepEqual(events,[{code:4002,reason:'client \u20ac',wasClean:true}]);
});

test('Server WebSocket close metadata is forwarded without replacing it with an abnormal close',async()=>{
  const {WS,emit}=fixture(),socket=new WS('/socket');await tick();emit([['open',{}]]);await tick();
  const ended=new Promise(resolve=>{socket.onclose=resolve;});
  emit([['close',{code:4001,reason:'server \u20ac',wasClean:true}]]);
  const event=await ended;assert.equal(event.code,4001);assert.equal(event.reason,'server \u20ac');assert.equal(event.wasClean,true);
});

test('WebSocket transport EOF keeps an abnormal close without inventing an error event',async()=>{
  const {WS,emit}=fixture(),socket=new WS('/socket');await tick();emit([['open',{}]]);await tick();
  const events=[];socket.onerror=()=>events.push('error');socket.onclose=event=>events.push({code:event.code,wasClean:event.wasClean});
  emit([['close',null]]);await tick();
  assert.deepEqual(events,[{code:1006,wasClean:false}]);assert.equal(socket.readyState,WS.CLOSED);
});

test('WebSocket close converts supplied arguments before validating codes and retains native numeric errors',async()=>{
  const {WS,emit}=fixture(),socket=new WS('/socket');await tick();emit([['open',{}]]);await tick();
  assert.throws(()=>socket.close(undefined,'reason'),{name:'InvalidAccessError'});
  assert.throws(()=>socket.close(0),{name:'InvalidAccessError'});
  assert.throws(()=>socket.close(1000n),TypeError);
  assert.throws(()=>socket.close(1000,Symbol('reason')),TypeError);
  const sentinel=new Error('reason conversion');
  assert.throws(()=>socket.close(1001,{toString(){throw sentinel;}}),error=>error===sentinel);
  assert.equal(socket.readyState,WS.OPEN);socket.close(undefined);await tick();
});

test('Host adapter releases pending sessions and exposes selected handshake protocol', () => {
  let released = 0;
  class Session { close() { released++; } }
  class Curl extends Session {
    constructor() { super(); this.session_ptr = 1; this.connected = false; this.onclose = () => {}; }
    create_request(url, data, end, headers) {
      for (const line of ['HTTP/1.1 101 Switching Protocols\r\n', 'Sec-WebSocket-', 'Protocol: selected\r\n\r\n']) headers(new TextEncoder().encode(line));
    }
  }
  const Relay = relay_websocket_class(Curl), socket = new Relay();
  socket.create_request('', () => {}, () => {}, () => {});
  assert.equal(socket.protocol, 'selected');
  socket.cleanup(); socket.cleanup(); assert.equal(released, 1);
});

test('WebSocket cookies use HTTP schemes, path, Secure, SameSite and HttpOnly rules', () => {
  const store = new SiteDataStore();
  for (const cookie of ['strict=s; SameSite=Strict; Path=/', 'lax=l; SameSite=Lax; Path=/',
    'none=n; SameSite=None; Secure; Path=/', 'session=secret; HttpOnly; Secure; Path=/socket',
    'other=hidden; Path=/other', 'expired=old; Max-Age=0; Path=/']) store.setCookie('https://chat.example.test/', cookie);
  const options = (url, source = 'https://chat.example.test/', top_url = source) =>
    websocket_options(store, url, {url: source, top_url, userAgent: 'test browser'});
  const own = options('wss://chat.example.test/socket/live');
  assert.deepEqual(new Set(own.headers.Cookie.split('; ')), new Set(['strict=s', 'lax=l', 'none=n', 'session=secret']));
  assert.equal(own.headers.Origin, 'https://chat.example.test');
  assert.equal(own.headers['User-Agent'], 'test browser');
  assert.equal(options('wss://chat.example.test/socket/live', 'https://different.test/').headers.Cookie, 'none=n');
  assert.equal(options('wss://chat.example.test/', 'https://chat.example.test/', 'https://different.test/').headers.Cookie, 'none=n');
  assert.equal(options('ws://chat.example.test/', 'http://chat.example.test/').headers.Cookie, 'strict=s; lax=l');
  assert.equal(options('wss://unrelated.test/').headers.Cookie, undefined);
  const opaque=websocket_options(store,'wss://chat.example.test/socket/live',{url:'https://chat.example.test/',broadcast_origin:'opaque:frame',userAgent:'test browser'});
  assert.equal(opaque.headers.Origin,'null');
  assert.equal(opaque.headers.Cookie,'none=n');
  assert.throws(() => options('https://chat.example.test/'), TypeError);
  own.onHeader('set-cookie', 'handshake=accepted; HttpOnly; Path=/');
  assert.ok(store.cookies.getCookieStringSync('https://chat.example.test/').includes('handshake=accepted'));
  assert.ok(!JSON.stringify(store.documentCookies('https://chat.example.test/')).includes('handshake'));
});

test('Host adapter forwards each Set-Cookie field without joining or UTF-8 corruption', () => {
  class Session { close() {} }
  class Curl extends Session {
    constructor(options) { super(); this.options = options; }
    create_request(url, data, end, headers) {
      const raw = 'HTTP/1.1 101 Switching Protocols\r\nSet-Cookie: a=one; Expires=Wed, 21 Oct 2037 07:28:00 GMT\r\nSet-Cookie: b=\xe9; HttpOnly\r\n\r\n';
      for (const character of raw) headers(new Uint8Array([character.charCodeAt(0)]));
    }
  }
  const fields = [], Relay = relay_websocket_class(Curl);
  new Relay({onHeader: (name, value) => fields.push([name, value])}).create_request('', () => {}, () => {}, () => {});
  assert.deepEqual(fields, [['set-cookie', 'a=one; Expires=Wed, 21 Oct 2037 07:28:00 GMT'], ['set-cookie', 'b=\xe9; HttpOnly']]);
});
