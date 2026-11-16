import test from 'node:test';
import assert from 'node:assert/strict';
import {create_websocket_class} from '../src/frame/websocket.mjs';
import {relay_websocket_class} from '../src/host/websocket.mjs';

globalThis.CloseEvent ||= class CloseEvent extends Event {
  constructor(type, options) { super(type); Object.assign(this, options); }
};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(extra = {}) {
  let wake;
  const sent = [], closed = [];
  const WS = create_websocket_class({base: () => 'https://site.test/base/',
    connect: async () => 1, events: () => new Promise(resolve => { wake = resolve; }),
    send: async (id, data) => sent.push(data), close: async id => closed.push(id), ...extra});
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
