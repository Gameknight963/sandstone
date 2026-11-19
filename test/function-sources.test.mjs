import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {rewrite_source} from '../src/frame/rewrite/javascript.mjs';
import {create_function_sources} from '../src/frame/rewrite/function_sources.mjs';

const expressions=[
  'function portable(){return this.value+location.href}',
  '(value=()=>location.href)=>this.value+value()',
  'async function* stream(){yield this.value}',
  '({get value(){return this.location}})',
  '({async *[(()=>"key")()](){yield location.href}})',
  'class Example extends (function Base(){}) {static /* trivia */ get value(){return this.location} method(value=()=>location.href){return value()}}',
  'class Example {#value=1;static {this.href=location.href} read(){return this.#value}}',
  'function strict(){"use strict";return this}',
  'function literal(){return "__ctx__.location __get_this__(this,false)"}'
];
const inspect=value=>{
  const result=typeof value==='function'?[Function.prototype.toString.call(value)]:[];
  for(const target of [value,value.prototype].filter(Boolean))for(const key of Reflect.ownKeys(target)){
    if(['constructor','caller','arguments'].includes(key))continue;
    const descriptor=Object.getOwnPropertyDescriptor(target,key);
    for(const fn of [descriptor.value,descriptor.get,descriptor.set])if(typeof fn==='function')result.push(Function.prototype.toString.call(fn));
  }
  return result;
};
test('Authored function and class sources retain native ranges across instrumentation',()=>{
  let sequence=0;const sources=create_function_sources(new Map(),()=>String(++sequence));
  for(const expression of expressions){
    const source='('+expression+')',native=runInNewContext(source,{location:{href:'native'}});
    const rewritten=rewrite_source(source,['location'],{functionSources:sources});
    const actual=runInNewContext(rewritten,{__ctx__:{location:{href:'native'}},__get_this__:value=>value});
    assert.deepEqual(inspect(actual).map(value=>sources.original(value)??value),inspect(native),expression);
  }
});
test('Nested defaults select the enclosing source and old literal markers cannot replace it',()=>{
  let sequence=0;const records=new Map(),sources=create_function_sources(records,()=>String(++sequence));
  const source='(function parent(value=()=>this.value){return ()=>location.href})';
  const rewritten=rewrite_source(source,['location'],{functionSources:sources});
  const fn=runInNewContext(rewritten,{__ctx__:{location:{href:'native'}},__get_this__:value=>value});
  assert.equal(sources.original(Function.prototype.toString.call(fn)),source.slice(1,-1));
  const next='(function literal(){return '+JSON.stringify(rewritten)+'})';
  const value=runInNewContext(rewrite_source(next,[],{functionSources:sources}));
  assert.equal(sources.original(Function.prototype.toString.call(value)),next.slice(1,-1));
});
test('Shared realm registries keep source identities distinct without a random nonce',()=>{
  const records=new Map(),first=create_function_sources(records,()=> 'fallback'),second=create_function_sources(records,()=> 'fallback');
  const compile=(sources,source)=>Function.prototype.toString.call(runInNewContext(rewrite_source('('+source+')',[],{functionSources:sources})));
  const one='function first(){return 1}',two='function second(){return 2}';
  const firstText=compile(first,one),secondText=compile(second,two);
  assert.equal(second.original(firstText),one);
  assert.equal(first.original(secondText),two);
});
