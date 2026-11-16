import test from 'node:test';
import assert from 'node:assert/strict';
import {bind_global_function} from '../src/frame/global_functions.mjs';

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
