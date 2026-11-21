import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {rewrite_source} from '../src/frame/rewrite/javascript.mjs';
import {create_worker_script_loader} from '../src/frame/worker_loader.mjs';

const source=`class Loader {load(manager,url,loaded,failed){const options=manager.getConfig().getOptionsLiteral();try{options.policy&&(url=options.policy(url)),importScripts(url),loaded()}catch(error){failed(error)}}}`;
const promiseSource=`function load(url){return new Promise(loaded=>{if('document' in self){throw new Error('Wrong transport')}else self.moduleURL=url,importScripts(url),loaded()});}`;

test('Promise transports retain lexical module metadata until each prepared import executes',async()=>{
  const source='let moduleURL;'+promiseSource.replace('self.moduleURL','moduleURL');
  const waiting=[],trace=[];let result;
  const output=rewrite_source(source+';({jobs:[load("one.js"),load("two.js")],metadata:()=>moduleURL})',['self','importScripts'],{workerLoaders:true});
  result=runInNewContext(output,{__ctx__:{self:{},importScripts:url=>trace.push([url,result.metadata()]),__load_worker_scripts__(paths,loaded,failed,run){waiting.push(()=>{try{run(...paths);loaded();}catch(error){failed(error);}});}}});
  assert.equal(waiting.length,2);assert.equal(result.metadata(),undefined);
  waiting[1]();waiting[0]();await Promise.all(result.jobs);
  assert.deepEqual(trace,[['two.js','two.js'],['one.js','one.js']]);
});

test('Lexical Promise transport matching leaves unbound, immutable, executor-local and TDZ metadata alone',()=>{
  const lexical=promiseSource.replace('self.moduleURL','moduleURL');
  for(const source of [lexical,'const moduleURL=0;'+lexical,lexical.replace("if('document'", "let moduleURL;if('document'"),lexical+';let moduleURL;', 'let moduleURL;'+lexical.replace('else moduleURL=', 'else {const moduleURL=0;moduleURL=').replace('loaded()});','loaded()}});')]){
    assert.doesNotMatch(rewrite_source(source,['self','importScripts'],{workerLoaders:true}),/__load_worker_scripts__/);
  }
});

test('Promise AMD transports prepare lazy imports and set module metadata at execution time',async()=>{
  const waiting=[],trace=[],self={};
  const output=rewrite_source(promiseSource+';[load("one.js"),load("two.js")];',['self','importScripts'],{workerLoaders:true});
  const promises=runInNewContext(output,{__ctx__:{self,importScripts:url=>trace.push([url,self.moduleURL]),__load_worker_scripts__(paths,loaded,failed,run){waiting.push(()=>{try{run(...paths);loaded()}catch(error){failed(error)}});}}});
  assert.equal(waiting.length,2);assert.equal(self.moduleURL,undefined);waiting[1]();waiting[0]();await Promise.all(promises);assert.deepEqual(trace,[['two.js','two.js'],['one.js','one.js']]);
});

test('Promise worker import failures reject both authored and injected rejection callbacks',async()=>{
  for(const source of [promiseSource,promiseSource.replace('loaded=>','(loaded,failed)=>'),promiseSource.replace('loaded=>','function(loaded)')]){
    const compiled=rewrite_source(source+';load("missing.js");',['self','importScripts'],{workerLoaders:true});
    const promise=runInNewContext(compiled,{__ctx__:{self:{},importScripts(){throw new DOMException('Missing','NetworkError');},__load_worker_scripts__(paths,loaded,failed,run){queueMicrotask(()=>{try{run(...paths);loaded()}catch(error){failed(error)}});}}});
    await assert.rejects(promise,{name:'NetworkError'});
  }
});

test('Promise transport rewriting leaves shadowed APIs and ordinary synchronous executors intact',()=>{
  for(const source of [
    '(function(Promise){'+promiseSource+'})(Promise);',
    '(function(importScripts){'+promiseSource+'})(importScripts);',
    '(function(self){'+promiseSource+'})(self);',
    promiseSource.replace("if('document' in self){throw new Error('Wrong transport')}else self.moduleURL=url,",''),
    promiseSource.replace("if('document' in self)","'use strict';if('document' in self)"),
  ])assert.doesNotMatch(rewrite_source(source,['self','importScripts'],{workerLoaders:true}),/__load_worker_scripts__/);
  assert.doesNotMatch(rewrite_source(promiseSource,['self','importScripts'],{workerLoaders:false}),/__load_worker_scripts__/);
});
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
