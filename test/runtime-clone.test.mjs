import test from 'node:test';
import assert from 'node:assert/strict';
import {clone_value,configure_clone} from '../src/frame/clone.mjs';

test('Runtime cloning retains native graph semantics after the public global is replaced',t=>{
  const native=globalThis.structuredClone;t.mock.method(globalThis,'structuredClone',()=>{throw new Error('Authored clone called')});
  const value={bytes:new Uint8Array([1,2]),map:new Map()};value.self=value;value.map.set(value,value.bytes);
  const copy=clone_value(value);assert.notEqual(copy,value);assert.equal(copy.self,copy);assert.equal(copy.map.get(copy),copy.bytes);assert.deepEqual([...copy.bytes],[1,2]);
  configure_clone(native);
});

test('Configured clone decoding remains installed after later authored overrides',t=>{
  const native=globalThis.structuredClone;t.after(()=>configure_clone(native));
  const token=new Blob(['opaque']),restored=Object.create(null);let calls=0;
  configure_clone(value=>{calls++;const result=native(value);return {payload:result,decoded:restored}});
  t.mock.method(globalThis,'structuredClone',()=>null);
  const result=clone_value({token});assert.equal(calls,1);assert.equal(result.decoded,restored);assert.notEqual(result.payload.token,token);assert.equal(result.payload.token.size,token.size);
});
