import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkerNames} from '../src/frame/rewrite/worker_names.mjs';
import {worker_module_intrinsics} from '../src/frame/module_namespace.mjs';

test('Worker name preparation preserves inference, directives, keyed methods and name mutations',async()=>{
  const source=String.raw`#!/usr/bin/env node
    const \u005f_sandstone_worker_names__=2;
    const \u005f_sandstone_worker_context__=3;
    const marker='sandstone-worker-name:0';
    export default class {static observed=this.name;}
    export function read(){
      'use strict';
      const __ctx__=null;
      function declared(){return declared.name}
      function parameters(value=()=>0,{fallback=function(){}}={}){return [value.name,fallback.name]}
      const arrow=()=>()=>0,anonymous=function(){},named=function Inner(){return Inner.name};
      const asyncFn=async()=>0,generator=function*(){},asyncGenerator=async function*(){};
      const before=named.name;Object.defineProperty(named,'name',{value:'custom'});const custom=named();delete named.name;
      let assigned;assigned ||= ()=>0;
      let reads=0;const key={toString(){reads++;return 'dynamic'}},symbol=Symbol('component');
      const object={[key]:()=>0,[symbol]:function(){},get value(){return 0},set value(value){},method(){}};
      class Fields{field=()=>0;#private=()=>0;static field=function(){};read(){return [this.field.name,this.#private.name]}}
      const descriptors=Object.getOwnPropertyDescriptors(object);
      let branch;switch('declared'){case declared.name:function declared(){};branch=declared.name;break;default:branch='wrong'}
      return {names:[declared.name,arrow.name,arrow().name,anonymous.name,assigned.name,asyncFn.name,generator.name,asyncGenerator.name],parameters:parameters(),
        named:[before,custom,named.name],keyed:[reads,object.dynamic.name,object[symbol].name,descriptors.value.get.name,descriptors.value.set.name,object.method.name],
        fields:[new Fields().read(),Fields.field.name,Fields.name],branch,alias:[\u005f_sandstone_worker_names__,\u005f_sandstone_worker_context__],marker,shadow:__ctx__};
    }
  `;
  const names=new WorkerNames([source]),transformed=names.finish(names.prepare(source));
  const native=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const previous=globalThis.__ctx__;globalThis.__ctx__={__module_intrinsics__:worker_module_intrinsics};
  try{
    const actual=await import('data:text/javascript;base64,'+Buffer.from(transformed).toString('base64'));
    assert.deepEqual(actual.read(),native.read());
    assert.equal(actual.default.name,native.default.name);assert.equal(actual.default.observed,native.default.observed);
    assert.deepEqual(Object.getOwnPropertyDescriptor(actual.default,'name'),Object.getOwnPropertyDescriptor(native.default,'name'));
  }finally{if(previous===undefined)delete globalThis.__ctx__;else globalThis.__ctx__=previous;}
});
