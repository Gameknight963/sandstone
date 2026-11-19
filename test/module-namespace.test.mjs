import test from 'node:test';
import assert from 'node:assert/strict';
import {create_module_namespace} from '../src/frame/module_namespace.mjs';

test('Bundled namespaces match native descriptors, key order, live values and mutation failures',async()=>{
  const native=await import('data:text/javascript,'+encodeURIComponent('export let count=1;export function bump(){count++}const a=10,b=2;export {a as "10",b as "2"};'));
  const value=Object.create(null);
  for(const key of Object.keys(native))Object.defineProperty(value,key,{get:()=>native[key],enumerable:true});
  const proxy=create_module_namespace(value);
  assert.deepEqual(Reflect.ownKeys(proxy),Reflect.ownKeys(native));
  // Compare descriptors individually: the descriptors object itself has an
  // object-valued Symbol.toStringTag, which Node's deep comparator special-cases.
  for(const key of Reflect.ownKeys(native))assert.deepEqual(Object.getOwnPropertyDescriptor(proxy,key),Object.getOwnPropertyDescriptor(native,key));
  const attempt=callback=>{try{return {value:callback()};}catch(error){return {error:error.name}}};
  for(const operation of [
    ns=>Reflect.set(ns,'count',42),ns=>Reflect.set(ns,'new',42),ns=>Reflect.deleteProperty(ns,'count'),ns=>Reflect.deleteProperty(ns,'absent'),
    ns=>Reflect.defineProperty(ns,'count',{value:ns.count}),ns=>Reflect.defineProperty(ns,'count',{value:99}),
    ns=>Reflect.defineProperty(ns,'count',{writable:false}),ns=>Reflect.defineProperty(ns,'count',{enumerable:false}),
    ns=>Reflect.defineProperty(ns,'count',{get:undefined}),ns=>Reflect.defineProperty(ns,Symbol.toStringTag,{value:'Module'}),
    ns=>Reflect.defineProperty(ns,Symbol.toStringTag,{enumerable:true}),ns=>Reflect.defineProperty(ns,Symbol('new'),{value:1}),
    ns=>Object.freeze(ns)===ns,ns=>Object.seal(ns)===ns,ns=>Object.isFrozen(ns),ns=>Object.isSealed(ns),
    ns=>Object.isExtensible(ns),ns=>Object.getPrototypeOf(ns),ns=>Object.prototype.toString.call(ns),ns=>structuredClone(ns)
  ])assert.deepEqual(attempt(()=>operation(proxy)),attempt(()=>operation(native)));
  native.bump();assert.equal(proxy.count,2);
  assert.deepEqual(Object.getOwnPropertyDescriptor(proxy,'count'),Object.getOwnPropertyDescriptor(native,'count'));
});
