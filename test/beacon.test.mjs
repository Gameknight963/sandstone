import test from 'node:test';
import assert from 'node:assert/strict';
import {beacon_body, create_beacon_sender} from '../src/frame/beacon.mjs';
import {BeaconQueue} from '../src/host/beacon.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
test('Preselected document tokens cannot overwrite another document or its quota leases',()=>{
  const queue=new BeaconQueue({fetch:()=>{},cookies:()=>({})}),token='0123456789abcdef0123456789abcdef';
  assert.equal(queue.register('first',{url:'https://first.test/'},token),token);
  const lease=queue.reserve(token,5);
  assert.throws(()=>queue.register('second',{url:'https://second.test/'},token),TypeError);
  for(const value of ['',{},42])assert.throws(()=>queue.register('second',{},value),TypeError);
  assert.equal(queue.contexts.get(token).frame,'first');assert.equal(queue.contexts.get(token).queued,5);lease.release();assert.equal(queue.contexts.get(token).queued,0);
});
test('Beacon bodies snapshot strings, binary subviews, blobs and URLSearchParams', async () => {
  const bytes = new Uint8Array([0, 2, 3, 0]), body = beacon_body(new DataView(bytes.buffer, 1, 2));
  bytes.fill(9);
  assert.deepEqual([...new Uint8Array(await body.arrayBuffer())], [2, 3]);
  assert.equal(body.type, '');
  assert.equal(await beacon_body('hello €').text(), 'hello €');
  assert.equal(beacon_body('hello').type, 'text/plain;charset=utf-8');
  assert.equal(await beacon_body(new URLSearchParams({q: 'a b'})).text(), 'q=a+b');
  assert.equal(beacon_body(null).size, 0);
  assert.throws(() => beacon_body(new ReadableStream()), TypeError);
  assert.throws(() => beacon_body(Symbol()), TypeError);
});

test('Beacon multipart encoding snapshots files and preserves form escaping/newlines', async () => {
  const form = new FormData();
  form.append('message\n"name', 'one\ntwo\rthree\r\nfour');
  form.append('file', new Blob([new Uint8Array([0,1,255])], {type:'application/custom'}), 'file"name.bin');
  const native = new Request('https://site.test/', {method:'POST', body:form});
  const body = beacon_body(form);
  form.set('message\n"name', 'changed');
  const parsed = await new Response(body, {headers:{'Content-Type':body.type}}).formData();
  const expected = await native.formData();
  assert.deepEqual([...parsed.keys()], [...expected.keys()]);
  assert.equal([...parsed.values()][0], [...expected.values()][0]);
  const file = parsed.get('file');
  assert.equal(file.name, expected.get('file').name); assert.equal(file.type, 'application/custom');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [0,1,255]);
});

test('sendBeacon validates synchronously and bounds all queued UTF-8 bytes until completion', async () => {
  let complete;
  const sent = [], send = create_beacon_sender({base: () => 'https://site.test/base/', dispatch(url, body) {
    sent.push({url, body}); return new Promise(resolve => { complete = resolve; });
  }});
  assert.throws(() => send(), TypeError);
  assert.throws(() => send('file:///local'), TypeError);
  assert.throws(() => send('http://['), TypeError);
  assert.equal(send('relative', '€'.repeat(21845)), true);
  assert.equal(sent[0].url, 'https://site.test/base/relative');
  assert.equal(send('/excess', 'xx'), false);
  assert.equal(sent.length, 1);
  complete(); await tick();
  assert.equal(send('/again', new Blob([new Uint8Array(65536)])), true);
  assert.equal(send('/overflow', 'x'), false);
  complete(); await tick();
  assert.equal(send('/too-large', new Blob([new Uint8Array(65537)])), false);
  const failed = create_beacon_sender({base: () => 'https://site.test/', dispatch() {throw new Error('queue unavailable');}});
  assert.equal(failed('/test', 'data'), false);
});

test('Host beacon queue retains original document context and survives retirement', async () => {
  let finish, received;
  const queue = new BeaconQueue({grace: 1, cookies: url => ({url}), fetch: async (url, options, context) => {
    received = {url, options, context}; await new Promise(resolve => { finish = resolve; }); return new Response('ignored');
  }});
  const context = {url:'https://old.test/page',top_url:'https://old.test/'};
  const id = queue.register('frame', context);
  context.url = 'https://new.test/page';
  const request = queue.send(id, 'https://old.test/beacon', beacon_body('saved'));
  await tick(); queue.retire('frame'); await tick(); await tick();
  assert.equal(queue.contexts.has(id), false); assert.equal(queue.pending.size, 1);
  assert.equal(received.context.url, 'https://old.test/page');
  assert.equal(received.options.headers.Origin, 'https://old.test');
  assert.equal(received.options.credentials, 'include');
  assert.equal(new TextDecoder().decode(received.options.body), 'saved');
  assert.equal(received.options.signal.aborted, false);
  finish(); assert.deepEqual(await request, {cookies:{url:'https://old.test/page'}});
  assert.equal(queue.pending.size, 0);
});

test('Host beacons retain an explicit empty referrer when a blank document changes URL', async () => {
  let received;
  const queue=new BeaconQueue({cookies:()=>null,fetch:async(url,options)=>{received=options;return new Response('done');}});
  const id=queue.register('frame',{url:'https://site.test/parent',referrer_url:'about:blank'});
  const pending=queue.send(id,'https://site.test/beacon',beacon_body('saved'),{referrer:''});
  queue.contexts.get(id).context.referrer_url=undefined;
  await pending;
  assert.equal(received.referrer,'');
});

test('Host queue releases quota after failures and rejects unknown/oversized requests', async () => {
  let finish;
  const queue = new BeaconQueue({cookies:()=>null, fetch:async()=>new Promise((resolve,reject)=>{finish=()=>reject(new Error('offline'));})});
  const id = queue.register('frame', {url:'https://site.test/'});
  assert.equal(await queue.send('missing', 'https://site.test/', new Blob([])), false);
  assert.equal(await queue.send(id, 'file:///local', new Blob([])), false);
  const pending = queue.send(id, 'https://site.test/', new Blob([new Uint8Array(65536)]));
  assert.equal(await queue.send(id, 'https://site.test/', new Blob(['x'])), false);
  await tick(); finish(); await pending;
  assert.equal(queue.contexts.get(id).queued, 0); assert.equal(queue.pending.size, 0);
});

test('Host beacon timeout aborts a stalled transport and releases its quota', async () => {
  let signal;
  const queue = new BeaconQueue({timeout: 5, cookies:()=>null, fetch:async(url, options)=>{
    signal=options.signal;
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  const id=queue.register('frame',{url:'https://site.test/'});
  const pending=queue.send(id,'https://site.test/beacon',beacon_body('saved'));
  await new Promise(resolve=>setTimeout(resolve,15));await pending;
  assert.equal(signal.aborted,true);assert.equal(queue.pending.size,0);assert.equal(queue.contexts.get(id).queued,0);
});
