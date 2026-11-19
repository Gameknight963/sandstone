import test from 'node:test';
import assert from 'node:assert/strict';
import {ModuleLoader,module_dependencies} from '../src/frame/modules.mjs';
import {rewrite_source} from '../src/frame/rewrite/javascript.mjs';

test('Module caches keep failed and successful imports of different types independent',async()=>{
  const requests=[],sources=new Map();
  const loader=new ModuleLoader({
    fetch:async url=>{requests.push(url);return new Response(url.endsWith('/json')?'{"value":42}':'export const value=7;',{headers:{'Content-Type':url.endsWith('/json')?'application/json':'text/javascript'}});},
    rewrite:(source,options)=>rewrite_source(source,[],options),createURL:source=>{const url='blob:typed/'+sources.size;sources.set(url,source);return url;},register(){},execute:async url=>url
  });
  const base='https://typed.test/';
  await assert.rejects(loader.import('/json',base),{name:'TypeError'});
  const json=await loader.import('/json',base,{with:{type:'json'}});
  assert.equal(await loader.import('/json',base,{with:{type:'json'}}),json);
  await assert.rejects(loader.import('/code',base,{with:{type:'json'}}),{name:'TypeError'});
  const code=await loader.import('/code',base);
  assert.equal(await loader.import('/code',base),code);
  assert.notEqual(loader.get_record(base+'json'),loader.get_record(base+'json','json'));
  assert.equal(loader.get_record(base+'json').blob,null);
  assert.equal(loader.get_record(base+'json','json').blob,json);
  assert.equal(requests.length,4);assert.equal(sources.size,2);
});

test('Static imports and namespace bridges pass the declared type to their resolver',()=>{
  const calls=[];
  const source=`import data from './same' with {type:'json'};import * as code from './same';export {default as sheet} from './same' with {type:'css'};export * as settings from './same' with {'type':'json'};`;
  const result=rewrite_source(source,[],{module:true,stripAttributes:true,
    resolve:(specifier,type)=>{calls.push([specifier,type]);return 'blob:'+type;},
    resolveNamespace:(specifier,type)=>type==='json'?'blob:json-namespace':undefined
  });
  assert.deepEqual(calls,[['./same','json'],['./same','javascript'],['./same','css']]);
  assert.match(result,/import data from "blob:json";/);
  assert.match(result,/import \* as code from "blob:javascript";/);
  assert.match(result,/from "blob:css";/);
  assert.match(result,/namespace as settings.*"blob:json-namespace"/);
  module_dependencies(result);
});

test('Unsupported static import attributes reject the graph before fetching dependencies',async()=>{
  for(const [source,name] of [[`import './code' with {unknown:'yes'};`,'SyntaxError'],[`export * from './code' with {type:'javascript'};`,'TypeError'],[`export {value} from './code' with {type:''};`,'TypeError']]){
    assert.throws(()=>module_dependencies(source),{name});
    const requests=[];
    const loader=new ModuleLoader({fetch:async url=>{requests.push(url);return new Response(source,{headers:{'Content-Type':'text/javascript'}});},rewrite(){throw new Error('Invalid graph was compiled')},createURL(){throw new Error('Invalid graph created a blob')},register(){},execute(){throw new Error('Invalid graph executed')}});
    await assert.rejects(loader.import('./entry','https://attributes.test/'),{name});
    assert.deepEqual(requests,['https://attributes.test/entry']);
  }
});
