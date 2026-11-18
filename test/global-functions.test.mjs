import test from 'node:test';
import assert from 'node:assert/strict';
import {bind_global_function, create_obj_proxy, global_method_names,bind_native_property} from '../src/frame/global_functions.mjs';

test('Virtual objects expose native constructors without leaking inherited adapter constructors',()=>{
  class Target{}class Adapter{get api(){return 'virtual';}}
  let reads=0;Object.defineProperty(Adapter.prototype,'constructor',{configurable:true,get(){reads++;return Adapter;}});
  const target=new Target(),adapter=new Adapter(),virtual=create_obj_proxy(adapter,['api'],target);
  assert.equal(virtual.constructor,Target);assert.equal(reads,0);assert.equal(virtual.api,'virtual');
  const patch=()=>{};virtual.constructor=patch;
  assert.equal(virtual.constructor,patch);assert.equal(target.constructor,patch);
  assert.equal(Object.getOwnPropertyDescriptor(virtual,'constructor').value,patch);
  delete virtual.constructor;assert.equal(virtual.constructor,Target);assert.equal(reads,0);
  Object.defineProperty(target,'constructor',{configurable:true,get(){return Target;}});
  assert.equal(Object.getOwnPropertyDescriptor(virtual,'constructor').get.call(virtual),Target);assert.equal(reads,0);
  function Explicit(){}
  assert.equal(create_obj_proxy({constructor:Explicit},[],new Target()).constructor,Explicit);
  assert.equal(create_obj_proxy(adapter,['constructor'],new Target()).constructor,Adapter);assert.equal(reads,1);
});

test('Explicit descriptor replacement does not observe an obsolete virtual getter',()=>{
  const target={api:'native'},virtual=create_obj_proxy({},['api'],target);let reads=0;
  Object.defineProperty(virtual,'api',{configurable:true,enumerable:true,get(){reads++;return 'old';}});
  function replacement(){}
  Object.defineProperty(target,'api',{value:replacement,writable:true,enumerable:true,configurable:false});
  Object.defineProperty(virtual,'api',Object.getOwnPropertyDescriptor(target,'api'));
  assert.equal(reads,0);assert.equal(virtual.api,replacement);
  assert.deepEqual(Object.getOwnPropertyDescriptor(virtual,'api'),Object.getOwnPropertyDescriptor(target,'api'));
});

test('Published native slots retain shared writes, accessor definitions and deletion',()=>{
  const target={api:()=> 'initial'},virtual=create_obj_proxy({api:()=> 'virtual'},['api'],target);
  Object.defineProperty(virtual,'api',Object.getOwnPropertyDescriptor(target,'api'));
  bind_native_property(virtual,'api');
  const assigned=()=> 'assigned';target.api=assigned;
  assert.equal(virtual.api,assigned);
  const replaced=()=> 'replaced';virtual.api=replaced;
  assert.equal(target.api,replaced);
  const descriptor={configurable:true,enumerable:true,get(){return assigned;}};
  Object.defineProperty(virtual,'api',descriptor);
  assert.deepEqual(Object.getOwnPropertyDescriptor(target,'api'),Object.getOwnPropertyDescriptor(virtual,'api'));
  assert.equal(target.api,virtual.api);
  delete target.api;
  assert.equal(virtual.api,undefined);assert.equal('api'in virtual,false);
  assert.equal(Object.getOwnPropertyDescriptor(virtual,'api'),undefined);
  assert.equal(Reflect.ownKeys(virtual).includes('api'),false);
});

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

test('Assigned callback values retain identity through properties, getters and reflection',()=>{
  const target={},virtual=create_obj_proxy({},[],target),callback=()=>42;
  Object.defineProperty(target,'forwarded',{configurable:true,get(){return target.callback;}});
  virtual.callback=callback;
  assert.equal(virtual.callback,callback);
  assert.equal(virtual.forwarded,callback);
  assert.equal(Object.getOwnPropertyDescriptor(virtual,'callback').value,callback);
  virtual.onmessage=callback;
  assert.equal(virtual.onmessage,callback);
  const replacement=()=>17;virtual.callback=replacement;
  assert.equal(virtual.callback,replacement);assert.equal(virtual.forwarded,replacement);
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

test('Reflected data properties expose the same virtual APIs and method identities as normal reads',()=>{
  const target={api(){return 'native';},method(){return this===target;}},api=()=> 'virtual';
  const virtual=create_obj_proxy({api},['api'],target);
  assert.equal(Object.getOwnPropertyDescriptor(virtual,'api').value,api);
  assert.equal(Reflect.getOwnPropertyDescriptor(virtual,'api').value,virtual.api);
  const descriptors=Object.getOwnPropertyDescriptors(virtual);
  assert.equal(descriptors.api.value,api);assert.equal(descriptors.method.value,virtual.method);
  const method=descriptors.method.value;assert.equal(method(),true);
  virtual.alias=api;assert.equal(virtual.alias,virtual.api);
});

test('Reflected virtual accessors stay lazy, retain getter identity and preserve borrowed native receivers',()=>{
  let nativeReads=0,virtualReads=0;
  const target={backing:'native'};
  Object.defineProperty(target,'storage',{configurable:true,enumerable:true,get(){nativeReads++;return this.backing;}});
  const obj={get storage(){virtualReads++;return 'virtual';}},virtual=create_obj_proxy(obj,['storage'],target);
  const original=Object.getOwnPropertyDescriptor(virtual,'storage');
  assert.equal(nativeReads,0);assert.equal(virtualReads,0);
  assert.equal(original.get,Object.getOwnPropertyDescriptor(virtual,'storage').get);
  assert.equal(original.get.call(virtual),'virtual');assert.equal(virtualReads,1);assert.equal(nativeReads,0);
  assert.equal(original.get.call({backing:'borrowed'}),'borrowed');assert.equal(nativeReads,1);
  Object.defineProperty(virtual,'storage',{get(){return this===virtual?'patched':'wrong';}});
  assert.equal(virtual.storage,'patched');assert.equal(original.get.call(virtual),'virtual');
});

test('Descriptor-based instrumentation and restoration preserve virtual APIs and writable flags',()=>{
  const target={api(){return 'native';}},api=()=> 'virtual',virtual=create_obj_proxy({api},['api'],target);
  const original=Object.getOwnPropertyDescriptor(virtual,'api');
  const patched=()=>original.value()+' patched';
  Object.defineProperty(virtual,'api',{value:patched,writable:false});
  assert.equal(virtual.api(), 'virtual patched');assert.equal(Object.getOwnPropertyDescriptor(virtual,'api').value,patched);
  assert.equal(Reflect.set(virtual,'api',api),false);assert.throws(()=>{virtual.api=api;},TypeError);
  Object.defineProperty(virtual,'api',original);assert.equal(virtual.api,api);assert.equal(target.api(),'native');
});

test('Fixed virtual data descriptors obey Proxy invariants and cannot be rewritten or deleted',()=>{
  const api=()=> 'virtual',target={api(){return 'native';}},virtual=create_obj_proxy({api},['api'],target);
  Object.defineProperty(virtual,'api',{configurable:false,writable:false});
  assert.equal(virtual.api,api);assert.equal(target.api,api);
  assert.deepEqual(Object.getOwnPropertyDescriptor(virtual,'api'),Object.getOwnPropertyDescriptor(target,'api'));
  assert.equal(Reflect.set(virtual,'api',()=>{}),false);assert.equal(Reflect.deleteProperty(virtual,'api'),false);
  assert.equal(Reflect.defineProperty(virtual,'api',{value:()=>{}}),false);
});

test('Deleting and restoring an API updates property reads, keys, descriptors and presence consistently',()=>{
  const api=()=> 'virtual',target={api(){return 'native';}},virtual=create_obj_proxy({api},['api'],target);
  const original=Object.getOwnPropertyDescriptor(virtual,'api');
  assert.equal(Reflect.deleteProperty(virtual,'api'),true);assert.equal(virtual.api,undefined);
  assert.equal('api'in virtual,false);assert.equal(Object.hasOwn(virtual,'api'),false);assert.ok(!Reflect.ownKeys(virtual).includes('api'));
  Object.defineProperty(virtual,'api',original);assert.equal(virtual.api,api);
  assert.equal('api'in virtual,true);assert.equal(Object.hasOwn(virtual,'api'),true);assert.ok(Reflect.ownKeys(virtual).includes('api'));
  assert.equal(Reflect.deleteProperty(virtual,'api'),true);assert.equal(virtual.api,undefined);
});

test('Preventing extensions and freezing retains virtual values without violating descriptor invariants',()=>{
  const api=()=> 'virtual',target={api(){return 'native';}},virtual=create_obj_proxy({api},['api','extra'],target);
  virtual.extra=42;
  Object.preventExtensions(virtual);assert.equal(Object.isExtensible(virtual),false);
  assert.deepEqual(Reflect.ownKeys(virtual),Reflect.ownKeys(target));assert.equal(virtual.extra,42);assert.equal(virtual.api,api);
  assert.equal(Reflect.defineProperty(virtual,'missing',{value:1}),false);
  Object.freeze(virtual);assert.equal(Object.isFrozen(virtual),true);assert.equal(virtual.api,api);
  assert.equal(Reflect.set(virtual,'api',null),false);
});

test('Reflect.set and inherited writes update their receiver without replacing a virtual API',()=>{
  const api=()=> 'virtual',target={api(){return 'native';}},virtual=create_obj_proxy({api},['api'],target),other={};
  assert.equal(Reflect.set(virtual,'api',42,other),true);assert.equal(other.api,42);assert.equal(virtual.api,api);
  const child=Object.create(virtual);child.api='child';assert.equal(child.api,'child');assert.equal(virtual.api,api);
  assert.equal(Reflect.set(virtual,'api','invalid',null),false);assert.equal(virtual.api,api);
  Object.defineProperty(virtual,'api',{value:api});
  Object.defineProperty(target,'api',{value:1,writable:false,configurable:false});
  assert.equal(Reflect.set(virtual,'api',2,other),false);assert.equal(virtual.api,1);
});

test('Virtual callable reflection and aliases never inspect authored function properties',()=>{
  let reads=0;
  const api=new Proxy(()=>42,{get(target,key,receiver){reads++;throw new Error('Unexpected callable property read: '+String(key));}});
  const virtual=create_obj_proxy({api},['api'],{api(){return 'native';}});
  assert.equal(virtual.api,api);assert.equal(Object.getOwnPropertyDescriptor(virtual,'api').value,api);
  virtual.alias=api;assert.equal(virtual.alias,api);assert.equal(virtual.alias(),42);assert.equal(reads,0);
});

test('Virtual own keys retain numeric/string/symbol ordering when new API slots are defined',()=>{
  const symbol=Symbol('metadata'),target={[symbol]:'symbol'},virtual=create_obj_proxy({},['2','1','extra'],target);
  virtual['2']='two';virtual.extra='extra';virtual['1']='one';
  const native={[symbol]:'symbol'};native['2']='two';native.extra='extra';native['1']='one';
  assert.deepEqual(Reflect.ownKeys(virtual),Reflect.ownKeys(native));
  assert.deepEqual(Object.keys(virtual),Object.keys(native));
});
