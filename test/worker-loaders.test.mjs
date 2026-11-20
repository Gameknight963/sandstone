import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {rewrite_source} from '../src/frame/rewrite/javascript.mjs';
import {create_worker_script_loader} from '../src/frame/worker_loader.mjs';

const source=`class Loader {load(manager,url,loaded,failed){const options=manager.getConfig().getOptionsLiteral();try{options.policy&&(url=options.policy(url)),importScripts(url),loaded()}catch(error){failed(error)}}}`;
test('Worker AMD callback transports prepare lazy scripts while preserving callbacks and native import overrides',()=>{
  const trace=[],manager={getConfig:()=>({getOptionsLiteral:()=>({policy:url=>{trace.push('policy');return url+'?policy';}})})};let finish;
  const imports=()=>trace.push('custom-import');
  const compiled=rewrite_source(source+';new Loader().load(manager,"./lazy.js",()=>trace.push("loaded"),error=>trace.push(error.name));',['importScripts'],{workerLoaders:true});
  runInNewContext(compiled,{manager,trace,__ctx__:{importScripts:imports,__load_worker_scripts__(paths,loaded,failed,execute){assert.deepEqual([...paths],['./lazy.js?policy']);assert.equal(execute,imports);trace.push('prepare');finish=()=>{execute();loaded();};}}});
  assert.deepEqual(trace,['policy','prepare']);finish();assert.deepEqual(trace,['policy','prepare','custom-import','loaded']);
});

test('Ordinary synchronous imports, shadowed imports and non-worker scripts keep their authored execution',()=>{
  for(const workerLoaders of [false,true]){
    const trace=[];
    const code='(function(importScripts){'+source+';new Loader().load(manager,"./local.js",()=>trace.push("loaded"),error=>trace.push(error.name));})(url=>trace.push(url));';
    runInNewContext(rewrite_source(code,['importScripts'],{workerLoaders}),{trace,manager:{getConfig:()=>({getOptionsLiteral:()=>({})})},__ctx__:{__load_worker_scripts__(){throw new Error('Must stay synchronous');}}});
    assert.deepEqual(trace,['./local.js','loaded']);
  }
  const trace=[];runInNewContext(rewrite_source('importScripts("./plain.js");trace.push("after")',['importScripts'],{workerLoaders:true}),{trace,__ctx__:{importScripts:url=>trace.push(url)}});assert.deepEqual(trace,['./plain.js','after']);
});

test('Callback worker loading deduplicates preparation and resolves nested imports against the worker entry',async()=>{
  const cache={},seen=[],executions=[],metadata=[];let release;
  const gate=new Promise(resolve=>release=resolve),base='https://app.test/workers/main.js';
  const load=create_worker_script_loader({cache,base:()=>base,resolve:path=>new URL(path,base).href,remember:(url,response)=>metadata.push([url,response.url]),fetch:async url=>{
    seen.push(url);if(url.endsWith('/lazy.js'))await gate;
    const response=new Response(url.endsWith('/lazy.js')?'importScripts("./nested.js");globalThis.value=42;':'globalThis.nested=true;');
    Object.defineProperty(response,'url',{value:url.endsWith('/lazy.js')?'https://cdn.test/final/runtime.js':url});return response;
  },execute:url=>{assert.equal(typeof cache['https://app.test/workers/nested.js'],'string');executions.push(url);}});
  const request=()=>new Promise((resolve,reject)=>load(['https://app.test/assets/lazy.js'],resolve,reject));const first=request(),second=request();release();await Promise.all([first,second]);
  assert.deepEqual(seen,['https://app.test/assets/lazy.js','https://app.test/workers/nested.js']);assert.equal(executions.length,2);assert.equal(metadata[0][1],'https://cdn.test/final/runtime.js');
  let synchronous=false;load(['https://app.test/assets/lazy.js'],()=>synchronous=true,assert.fail);assert.equal(synchronous,true);
});

test('Worker loader adaptation preserves catch bindings and existing async transport contracts',()=>{
  const code='class Loader{load(manager,url,loaded,failed){manager.getConfig().getOptionsLiteral();try{let failed=0;importScripts(url);loaded()}catch(error){failed(error)}}};new Loader().load(manager,"/fail",()=>trace.push("loaded"),error=>trace.push(error.message));';
  const trace=[];runInNewContext(rewrite_source(code,['importScripts'],{workerLoaders:true}),{trace,manager:{getConfig:()=>({getOptionsLiteral(){}})},__ctx__:{importScripts(){throw new Error('expected');},__load_worker_scripts__(){throw new Error('Wrong catch binding');}}});assert.deepEqual(trace,['expected']);
  assert.doesNotMatch(rewrite_source(source.replace('load(manager','async load(manager'),['importScripts'],{workerLoaders:true}),/__load_worker_scripts__/);
});

test('Failed late worker requests do not execute or poison a later retry',async()=>{
  const cache={};let calls=0,executions=0,wrapperCalls=0;
  const load=create_worker_script_loader({cache,resolve:url=>url,fetch:async()=>++calls===1?new Response('',{status:503}):new Response('success'),execute:url=>{wrapperCalls++;if(typeof cache[url]!=='string')throw new DOMException('Import failed','NetworkError');executions++;}});
  const request=()=>new Promise((resolve,reject)=>load(['https://app.test/lazy.js'],resolve,reject));await assert.rejects(request(),{name:'NetworkError'});assert.equal(executions,0);assert.equal(wrapperCalls,1);await request();assert.equal(executions,1);assert.equal(calls,2);assert.equal(wrapperCalls,2);
});
