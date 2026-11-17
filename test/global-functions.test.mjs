import test from 'node:test';
import assert from 'node:assert/strict';
import {bind_global_function, create_obj_proxy} from '../src/frame/global_functions.mjs';

test('Global method binding preserves native call/apply and borrowed EventTarget methods', () => {
  const target=new EventTarget(),virtual={},other=new EventTarget();
  const original=EventTarget.prototype.addEventListener;
  const before=Object.getOwnPropertyDescriptors(original);
  const wrapped=bind_global_function(target,original,virtual);
  const events=[];
  wrapped('event',()=>events.push('global'));
  wrapped.call(virtual,'event',()=>events.push('virtual'));
  wrapped.apply(other,['event',()=>events.push('borrowed')]);
  original.call(other,'event',()=>events.push('native'));
  target.dispatchEvent(new Event('event'));other.dispatchEvent(new Event('event'));
  assert.deepEqual(events,['global','virtual','borrowed','native']);
  assert.deepEqual(Object.getOwnPropertyDescriptors(original),before);
});

test('Virtual globals follow instrumentation patches, restoration and aliases', () => {
  const target = new EventTarget();
  const virtual = create_obj_proxy({}, [], target);
  const original = target.addEventListener;
  const before = virtual.addEventListener;
  const calls = [];
  target.addEventListener = {addEventListener(...args) {
    calls.push(this === target ? 'global' : 'borrowed');
    return Reflect.apply(original, this, args);
  }}.addEventListener;
  const patched = virtual.addEventListener;
  assert.notEqual(patched, before);
  assert.equal(virtual.addEventListener, patched);
  const other = new EventTarget();
  virtual.addEventListener('test', () => calls.push('event'));
  patched.call(other, 'test', () => calls.push('other event'));
  target.dispatchEvent(new Event('test'));
  other.dispatchEvent(new Event('test'));
  assert.deepEqual(calls, ['global', 'borrowed', 'event', 'other event']);
  target.alias = target.addEventListener;
  assert.equal(virtual.alias, patched);
  target.addEventListener = original;
  assert.equal(virtual.addEventListener, before);
  virtual.addEventListener = before;
  assert.equal(virtual.addEventListener, before);
  virtual.addEventListener = null;
  assert.equal(virtual.addEventListener, null);
});

test('Virtual global getters run once and preserve virtual overrides', () => {
  let reads = 0;
  const method = () => 'method';
  const target = {get changing() { reads++; return reads % 2 ? method : 42; }};
  const overrides = {custom: 'virtual'};
  const virtual = create_obj_proxy(overrides, ['custom'], target);
  assert.equal(virtual.changing(), 'method');
  assert.equal(reads, 1);
  assert.equal(virtual.changing, 42);
  assert.equal(reads, 2);
  virtual.custom = 'updated';
  assert.equal(overrides.custom, 'updated');
  assert.equal(target.custom, undefined);
});
