import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {bootstrap_html,bootstrap_worker,bootstrap_attribute,create_bootstrap_nonce} from '../src/bootstrap.mjs';

test('Bootstrap nonces use native random bytes without requiring randomUUID',()=>{
  let calls=0;
  assert.equal(create_bootstrap_nonce({getRandomValues(bytes){calls++;assert.equal(bytes.length,16);bytes.set(Array.from({length:16},(_,index)=>index*17));return bytes;}}),'00112233445566778899aabbccddeeff');
  assert.equal(calls,1);
});

test('HTML bootstrap binds the existing runtime script without adding executable markup',()=>{
  const source='<!doctype html><head><script type="text/javascript">runtime();</script><script>other();</script>';
  const output=bootstrap_html(source,'first',2);
  const config=html=>JSON.parse(decodeURIComponent(html.match(new RegExp(bootstrap_attribute+'="([^"]+)"'))[1]));
  assert.deepEqual(config(output),{nonce:'first',channels:2});
  const replaced=bootstrap_html(output,'second');
  assert.deepEqual(config(replaced),{nonce:'second',channels:1});
  assert.equal((replaced.match(/data-sandstone-bootstrap/g)||[]).length,1);
  assert.equal((replaced.match(/<script/g)||[]).length,2);
  assert.ok(replaced.includes('type="text/javascript"'));assert.ok(replaced.includes('runtime();</script><script>other();'));
});

test('Worker bootstrap configuration exists before runtime evaluation',()=>{
  const context={};runInNewContext(bootstrap_worker('globalThis.observed=globalThis.__sandstone_bootstrap__;','worker-secret'),context);
  assert.equal(context.observed.nonce,'worker-secret');assert.equal(context.observed.channels,1);
});
