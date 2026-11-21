import test from 'node:test';
import assert from 'node:assert/strict';
import {bind_global_function, create_obj_proxy, global_method_names,bind_native_property,bind_declared_property} from '../src/frame/global_functions.mjs';

test('Declared own bindings shadow inherited APIs and retain native property attributes',()=>{
  const prototype={api:()=> 'native'},target=Object.create(prototype),virtual=create_obj_proxy({api:()=> 'virtual'},['api'],target);
  Object.defineProperty(target,'api',{value:undefined,writable:true,enumerable:true,configurable:false});
  bind_declared_property(virtual,'api');assert.equal(virtual.api,undefined);
  const value=()=> 'assigned';virtual.api=value;
  assert.equal(target.api,value);assert.equal(virtual.api,value);assert.equal(prototype.api(),'native');
  assert.deepEqual(Object.getOwnPropertyDescriptor(virtual,'api'),Object.getOwnPropertyDescriptor(target,'api'));
});

test('An explicit inherited API override creates an own slot before a later var declaration',()=>{
  const target=Object.create({api:()=> 'native'}),virtual=create_obj_proxy({api:()=> 'virtual'},['api'],target),value=()=> 'assigned';
  virtual.api=value;assert.equal(Object.hasOwn(target,'api'),true);assert.equal(target.api,value);
  bind_declared_property(virtual,'api');assert.equal(virtual.api,value);
  assert.equal(Object.getOwnPropertyDescriptor(virtual,'api').configurable,true);
});

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

test('Window accessor views never return provisional native objects through bound or unbound reflected getters',()=>{
  const nativeNavigator={kind:'native'},virtualNavigator={kind:'virtual'},target={};let ready=false,nativeReads=0;
  Object.defineProperty(target,'navigator',{configurable:true,enumerable:true,get(){nativeReads++;if(this!=null&&this!==target)throw new TypeError('Illegal invocation');return nativeNavigator;}});
  const read=()=>ready?virtualNavigator:undefined;
  const view=create_obj_proxy({},[],target,undefined,read,undefined,{virtual_accessors:true});
  const first=Object.getOwnPropertyDescriptor(view,'navigator'),second=Object.getOwnPropertyDescriptor(view,'navigator');
  const get=first.get;
  assert.equal(first.get,second.get);assert.equal(first.enumerable,true);assert.equal(nativeReads,0);
  assert.equal(view.navigator,undefined);assert.equal(get(),undefined);assert.equal(first.get.call(null),undefined);
  assert.equal(first.get.call(view),undefined);assert.equal(first.get.call(target),undefined);assert.equal(nativeReads,0);
  ready=true;
  assert.equal(view.navigator,virtualNavigator);assert.equal(get(),virtualNavigator);assert.equal(first.get.call(view),virtualNavigator);
  assert.equal(first.get,Object.getOwnPropertyDescriptor(view,'navigator').get);assert.equal(nativeReads,0);
  assert.throws(()=>first.get.call({}),TypeError);assert.equal(nativeReads,1);
});

test('Borrowed Window getters and setters use the destination view without observing its property overrides',()=>{
  const writes=[],make=name=>{
    const target={};Object.defineProperty(target,'location',{configurable:true,enumerable:true,get(){throw new Error('Native location escaped');},set(){throw new Error('Native location setter escaped');}});
    const location={name},model={get location(){return location;},set location(value){writes.push([name,value]);}};
    return {target,view:create_obj_proxy(model,['location'],target,undefined,undefined,undefined,{virtual_accessors:true}),location};
  };
  const a=make('a'),b=make('b'),property=Object.getOwnPropertyDescriptor(a.view,'location');
  const {get,set}=property;
  assert.equal(get(),a.location);assert.equal(property.get.call(b.view),b.location);assert.equal(property.get.call(b.target),b.location);
  Object.defineProperty(b.view,'location',{value:'own override',configurable:true});
  assert.equal(b.view.location,'own override');assert.equal(property.get.call(b.view),b.location);
  set('default');property.set.call(b.view,'borrowed');property.set.call(b.target,'raw receiver');
  assert.deepEqual(writes,[['a','default'],['b','borrowed'],['b','raw receiver']]);
});

test('Unforgeable Window accessors reflect virtual slots and restore without changing native descriptors',()=>{
  const target={},location={href:'virtual'};let nativeReads=0;
  Object.defineProperty(target,'location',{enumerable:true,get(){nativeReads++;return 'native';},set(){throw new Error('Native navigation');}});
  const physical=Object.getOwnPropertyDescriptor(target,'location'),writes=[];
  const view=create_obj_proxy({get location(){return location;},set location(value){writes.push(value);}},['location'],target,undefined,undefined,undefined,{virtual_accessors:true});
  const property=Object.getOwnPropertyDescriptor(view,'location'),get=property.get,set=property.set;
  assert.equal(property.configurable,false);assert.equal(get(),location);assert.equal(get.call(view),location);
  assert.equal(Reflect.getOwnPropertyDescriptor(view,'location').get,get);
  assert.equal(Object.getOwnPropertyDescriptors(view).location.get,get);
  set('relative');assert.deepEqual(writes,['relative']);assert.equal(nativeReads,0);
  assert.equal(Object.defineProperty(view,'location',property),view);
  assert.equal(Reflect.defineProperty(view,'location',property),true);
  assert.equal(Object.defineProperties(view,{location:property}),view);
  assert.equal(Reflect.defineProperty(view,'location',{get(){}}),false);
  assert.throws(()=>Object.defineProperty(view,'location',{get(){}}),TypeError);
  assert.deepEqual(Object.getOwnPropertyDescriptor(target,'location'),physical);
  assert.equal(Reflect.deleteProperty(view,'location'),false);
  Object.preventExtensions(view);assert.equal(get(),location);assert.equal(Object.isExtensible(view),false);
});

test('Window getters without a replacement still adapt borrowed virtual receivers',()=>{
  const make=()=>{
    const target={navigator:{}};
    Object.defineProperty(target,'platform',{configurable:true,get(){if(this!==target)throw new TypeError('Illegal invocation');return this.navigator;}});
    return {target,view:create_obj_proxy({},[],target,undefined,undefined,undefined,{virtual_accessors:true})};
  };
  const a=make(),b=make(),{get}=Object.getOwnPropertyDescriptor(a.view,'platform');
  assert.equal(get(),a.target.navigator);assert.equal(get.call(b.view),b.target.navigator);
  assert.throws(()=>get.call({}),TypeError);
});

test('Window reflection converts property keys and descriptor fields once before applying definitions',()=>{
  const view=create_obj_proxy({},[],{},undefined,undefined,undefined,{virtual_accessors:true}),events=[];
  const key={[Symbol.toPrimitive](hint){events.push(hint);return 'value';}};
  const input=new Proxy({value:42,writable:true,configurable:true},{has(object,name){events.push('has:'+name);return Reflect.has(object,name);},get(object,name){events.push('get:'+name);return Reflect.get(object,name);}});
  assert.equal(Reflect.defineProperty(view,key,input),true);assert.equal(view.value,42);
  assert.deepEqual(events,['string','has:enumerable','has:configurable','get:configurable','has:value','get:value','has:writable','get:writable','has:get','has:set']);
  assert.throws(()=>Object.defineProperties(view,{first:{value:'should not install'},second:{get:1}}),TypeError);
  assert.equal(Object.hasOwn(view,'first'),false);
  assert.throws(()=>Object.defineProperties(view,undefined),TypeError);
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
