import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ModuleLoader,module_dependencies} from '../src/frame/modules.mjs';
import {rewrite_source} from '../src/frame/rewrite/javascript.mjs';
import {compile_worker_cycles as compile} from '../src/frame/worker_module_cycles.mjs';
import {rollup} from '@rollup/browser';
import {worker_module_intrinsics} from '../src/frame/module_namespace.mjs';
const compile_worker_cycles=(...args)=>compile(...args,rollup);

test('Cyclic worker compiler executes live exports, namespace bridges and later chunks with native ESM',async()=>{
  const base='https://worker-unit.test/',sources={
    'a.js':'import {read} from "./b.js";export let value=1;export function bump(){value++}export function readB(){return read()}export default 42;',
    'b.js':'import {value} from "./a.js";export function read(){return value}',
    'later.js':'import value,* as namespace from "./a.js";export {namespace};export * as again from "./a.js";export default value;',
    'bad-a.js':'import "./bad-b.js";export let value=1;',
    'bad-b.js':'import {value} from "./bad-a.js";globalThis.badWorkerValue=value;',
    'empty-a.js':'"use client";import "./empty-b.js";',
    'empty-b.js':'import "./empty-a.js";',
    'then-a.js':'import "./then-b.js";export function then(resolve){globalThis.workerThenRuns++;resolve(99)}',
    'then-b.js':'import "./then-a.js";',
    'names-a.js':'#!/usr/bin/env node\nimport * as b from "./names-b.js";export function open(){}export const render=()=>0;export default function(){};export function names(){return [open.name,render.name,b.early,b.names()]}',
    'names-b.js':'import {open as parentOpen} from "./names-a.js";const __ctx__=null,__get_this__=null;export const early=parentOpen.name;export function open(){}export const render=function(){};export default class {static observed=this.name;}export function names(){switch(parentOpen.name){case open.name:function open(){};return [open.name,render.name,__ctx__,__get_this__];default:return ["wrong",open.name];}}'
  };
  const loader=new ModuleLoader({
    fetch:async url=>new Response(sources[url.slice(base.length)]),
    rewrite:(source,options)=>rewrite_source(source,[],options),
    createURL:source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64'),
    register(){throw new Error('Worker graph attempted to register an import map')},
    execute:url=>import(url),compileCycles:compile_worker_cycles
  });
  const originalFetch=globalThis.fetch,originalContext=globalThis.__ctx__;
  const wasmURL=new URL('../node_modules/@rollup/browser/dist/es/bindings_wasm_bg.wasm',import.meta.url);
  // The published browser compiler fetches its bundled WASM. Node has no file:
  // fetch implementation, so serve only that exact local asset to the test.
  globalThis.fetch=(input,...args)=>String(input)===wasmURL.href?readFile(wasmURL).then(bytes=>new Response(bytes,{headers:{'Content-Type':'application/wasm'}})):originalFetch(input,...args);
  globalThis.__ctx__={__get_this__:value=>value,__globals__:{Object,Symbol},__module_intrinsics__:worker_module_intrinsics,__module_meta__:url=>loader.meta(url),__import__:(base,specifier,options)=>loader.import(specifier,base,options)};
  try{
    const first=await loader.import('./a.js',base),again=await loader.import('./a.js',base);
    assert.equal(first,again);assert.equal(Object.prototype.toString.call(first),'[object Module]');
    first.bump();assert.equal(first.value,2);assert.equal(first.readB(),2);
    const later=await loader.import('./later.js',base);
    assert.equal(later.namespace,first);assert.equal(later.again,first);assert.equal(later.default,42);
    first.bump();assert.equal(later.namespace.value,3);
    await assert.rejects(loader.import('./bad-a.js',base),{name:'ReferenceError'});
    assert.equal(globalThis.badWorkerValue,undefined);
    const empty=await loader.import('./empty-a.js',base);
    assert.deepEqual(Object.keys(empty),[]);assert.equal(Object.prototype.toString.call(empty),'[object Module]');
    globalThis.workerThenRuns=0;assert.equal(await loader.import('./then-a.js',base),99);assert.equal(globalThis.workerThenRuns,1);
    loader.preamble='__ctx__.started=(__ctx__.started||0)+1;';
    const named=await loader.import('./names-a.js',base),other=await loader.import('./names-b.js',base);
    assert.deepEqual(named.names(),['open','render','open',['open','render',null,null]]);
    assert.equal(named.default.name,'default');assert.equal(other.default.name,'default');assert.equal(other.default.observed,'default');
    assert.ok(globalThis.__ctx__.started>0);
  }finally{globalThis.fetch=originalFetch;if(originalContext===undefined)delete globalThis.__ctx__;else globalThis.__ctx__=originalContext;delete globalThis.badWorkerValue;delete globalThis.workerThenRuns;}
});

test('Namespace bridges retain default imports, string re-export names and lexical bindings',()=>{
  const source='import value,* as location from "./a.js";export * as "odd name" from "./a.js";export const result=[value,location];';
  const result=rewrite_source(source,['location'],{module:true,resolve:()=> 'blob:facade',resolveNamespace:()=> 'blob:namespace'});
  assert.match(result,/import value from "blob:facade";import \{namespace as location\} from "blob:namespace";/);
  assert.match(result,/export \{namespace as "odd name"\} from "blob:namespace";/);
  assert.doesNotMatch(result,/__ctx__\.location/);
  rewrite_source(result,[],{module:true});
});

test('Worker compilation closes graphs with multiple cycles, shared dependencies and acyclic leaves',async()=>{
  for(let seed=0;seed<16;seed++){
    const size=3+seed%6,base='https://graph-'+seed+'.test/',sources=new Map(),urls=new Map(),requests=new Map();
    for(let index=0;index<size;index++){
      const edges=new Set(index+1<size?[index+1]:[seed%(size-1)]);
      if(index&&((seed+index)%3===0))edges.add((seed+index)%index);
      edges.add((seed*3+index*5)%size);edges.delete(index);
      const names=[...edges].map(target=>'value'+target);
      sources.set(base+index+'.js',[...[...edges].map(target=>'import {id as value'+target+'} from "./'+target+'.js";'),'export const id='+index+';export function read(){return ['+names.join(',')+']}'].join('\n'));
    }
    const loader=new ModuleLoader({
      fetch:async url=>{requests.set(url,(requests.get(url)||0)+1);return new Response(sources.get(url));},
      rewrite:(source,options)=>rewrite_source(source,[],options),
      createURL(source){const url='blob:graph/'+seed+'/'+urls.size;urls.set(url,source);return url;},
      register(){throw new Error('Worker graph used an import map')},execute(){throw new Error('Preparation executed a module')},compileCycles:compile_worker_cycles
    });
    const entry=await loader.prepare_url('./0.js',base);
    assert.ok(entry.blob);assert.equal(requests.size,size);assert.ok([...requests.values()].every(count=>count===1));
    for(const source of urls.values()){
      for(const dependency of module_dependencies(source))assert.ok(urls.has(dependency.specifier),'Unclosed dependency in graph '+seed+': '+dependency.specifier);
    }
  }
});
