import test from 'node:test';
import assert from 'node:assert/strict';
import {bind_global_function, create_obj_proxy, global_method_names} from '../src/frame/global_functions.mjs';

test('Native method discovery includes inherited methods without invoking global getters or constructors',()=>{
  let reads=0;
  class Constructor {}
  const prototype={inherited(){}};
  const target=Object.assign(Object.create(prototype),{own(){},Constructor});
  Object.defineProperty(target,'unavailable',{get(){reads++;throw new Error('Unavailable');}});
  const names=global_method_names(target);
  assert.ok(names.includes('own'));assert.ok(names.includes('inherited'));
  assert.ok(!names.includes('Constructor'));assert.ok(!names.includes('unavailable'));
  assert.equal(reads,0);
});

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

test('Explicit undefined overrides hide native features without reading their getters',()=>{
  let reads=0;
  const target={method(){}};
  Object.defineProperty(target,'feature',{get(){reads++;throw new Error('Native feature must stay hidden');}});
  const overrides={get feature(){return undefined;}};
  const virtual=create_obj_proxy(overrides,['method'],target);
  assert.equal(virtual.feature,undefined);assert.equal(reads,0);
  assert.equal(typeof virtual.method,'function');
  virtual.method=undefined;
  assert.equal(virtual.method,undefined);assert.equal(typeof target.method,'function');
});
