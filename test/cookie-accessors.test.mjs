import test from 'node:test';
import assert from 'node:assert/strict';
import {create_cookie_accessors} from '../src/cookie_accessors.mjs';

test('Explicit document lifecycle probes do not mistake empty native cookies for an inactive document',()=>{
  const target={},alias={},writes=[];
  let active=true,nativeReads=0,value='session=present';
  const native={get(){nativeReads++;return '';},set(){throw new Error('Native cookie writes must not be used');}};
  const bridge=create_cookie_accessors(native,{isActive:document=>document===target&&active});
  bridge.register(target,alias,{get:()=>value,set:text=>{writes.push(text);value=text;}});
  assert.equal(bridge.is_active(alias),true);
  assert.equal(bridge.descriptor.get.call(alias),'session=present');
  bridge.descriptor.set.call(target,'session=updated');
  assert.deepEqual(writes,['session=updated']);assert.equal(nativeReads,0);
  active=false;
  assert.equal(bridge.is_active(target),false);assert.equal(bridge.descriptor.get.call(alias),'');
  bridge.descriptor.set.call(alias,'ignored=value');assert.deepEqual(writes,['session=updated']);
});

function fixture(){
  const documents=new WeakMap(),writes=[];
  const native={enumerable:true,configurable:true,get(){
    const state=documents.get(this);if(!state)throw new TypeError('Illegal invocation');
    if(state.error)throw state.error;
    if(state.active)throw new DOMException('Opaque origin','SecurityError');return '';
  },set(value){
    if(!documents.has(this))throw new TypeError('Illegal invocation');
    if(typeof value==='symbol')throw new TypeError('Symbol');String(value);
  }};
  const bridge=create_cookie_accessors(native);
  function register(registry){
    const target={},alias={},state={active:true,value:'cookie=value'};documents.set(target,state);
    bridge.register(target,alias,{get:()=>state.value,set:value=>{writes.push(value);state.value=value;return 'ignored';}},registry);
    return {target,alias,state};
  }
  return {bridge,native,register,documents,writes};
}

test('Cookie accessor adapters retain native metadata, convert values once and keep setter return values undefined',()=>{
  const {bridge,native,register,writes}=fixture(),{alias}=register();
  assert.equal(bridge.descriptor.enumerable,native.enumerable);assert.equal(bridge.descriptor.configurable,native.configurable);
  for(const key of ['get','set']){assert.equal(bridge.descriptor[key].name,native[key].name);assert.equal(bridge.descriptor[key].length,native[key].length);}
  let conversions=0;
  assert.equal(bridge.descriptor.set.call(alias,{toString(){conversions++;return 'converted=value';}}),undefined);
  assert.equal(bridge.descriptor.get.call(alias),'converted=value');assert.equal(conversions,1);
  bridge.descriptor.set.call(alias);assert.deepEqual(writes,['converted=value','undefined']);
});

test('Cookie accessors share only registered aliases and never inspect forged document properties',()=>{
  const first=fixture(),second=fixture(),registry=new WeakMap();first.register(registry);const other=second.register(registry);
  first.bridge.descriptor.set.call(other.alias,'cross=value');assert.equal(second.bridge.descriptor.get.call(other.target),'cross=value');
  let reads=0;const fake={get __target__(){reads++;return other.target;}};
  assert.throws(()=>first.bridge.descriptor.get.call(fake),TypeError);assert.throws(()=>first.bridge.descriptor.set.call(fake,'bad=value'),TypeError);
  assert.equal(reads,0);assert.deepEqual(first.writes,[]);assert.deepEqual(second.writes,['cross=value']);
});

test('Cookie coercion finishes before document liveness is checked and removed documents cannot write',()=>{
  const {bridge,register,writes}=fixture(),{alias,state}=register();
  let conversions=0;
  bridge.descriptor.set.call(alias,{toString(){conversions++;state.active=false;return 'ignored=value';}});
  assert.equal(conversions,1);assert.deepEqual(writes,[]);assert.equal(bridge.descriptor.get.call(alias),'');
  assert.throws(()=>bridge.descriptor.set.call(alias,Symbol()),TypeError);
  bridge.descriptor.set.call(alias,'still=ignored');assert.deepEqual(writes,[]);
});

test('Unregistered inert documents retain native behavior and unexpected native failures are preserved',()=>{
  const {bridge,register,documents,writes}=fixture(),inert={};documents.set(inert,{active:false});
  assert.equal(bridge.descriptor.get.call(inert),'');bridge.descriptor.set.call(inert,'ignored=value');assert.deepEqual(writes,[]);
  const {alias,state}=register(),failure=new Error('Native failure');state.error=failure;
  assert.throws(()=>bridge.descriptor.get.call(alias),error=>error===failure);
});

test('Document liveness probes use registered native owners without reading virtual cookies or forged properties',()=>{
  const first=fixture(),second=fixture(),registry=new WeakMap(),document=first.register(registry);second.register(registry);
  Object.defineProperty(document.state,'value',{get(){throw new Error('Virtual cookies must not be read');}});
  assert.equal(first.bridge.is_active(document.target),true);assert.equal(second.bridge.is_active(document.alias),true);
  let reads=0;const fake={get __target__(){reads++;return document.target;}};
  assert.equal(first.bridge.is_active(fake),false);assert.equal(reads,0);
  document.state.active=false;
  assert.equal(first.bridge.is_active(document.alias),false);assert.equal(second.bridge.is_active(document.target),false);
  const failure=new Error('Native probe failed');document.state.error=failure;
  assert.throws(()=>first.bridge.is_active(document.alias),error=>error===failure);
});
