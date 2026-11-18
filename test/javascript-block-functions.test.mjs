import test from 'node:test';
import assert from 'node:assert/strict';
import {Script} from 'node:vm';
import {rewrite_source} from '../src/frame/rewrite/javascript.mjs';
import {blockFunctionCases,globalBlockFunctionCases} from './javascript-block-functions-cases.mjs';

async function execute(source,physical){
  try{
    const context={fetch:()=> 'virtual'};context.globalThis=context;
    const global={fetch:()=>physical,__ctx__:context,__get_this__:value=>value};
    const value=await new Script(source).runInNewContext(global);
    return JSON.parse(JSON.stringify({value,result:Object.hasOwn(global,'result')?global.result:context.result}));
  }catch(error){return {error:error.name};}
}
for(const {name,body,module} of blockFunctionCases)test('Block functions preserve native bindings: '+name,async()=>{
  const source='(function(){'+body+'})()',prefix=module?'"use strict";':'';
  const expected=await execute(prefix+source,'virtual');
  assert.notEqual(expected.error,'SyntaxError','The native comparison must be valid JavaScript');
  assert.deepEqual(await execute(prefix+rewrite_source(source,['fetch'],{module}),'physical'),expected);
});

for(const {name,body} of globalBlockFunctionCases)test('Top-level block functions preserve virtual global reads: '+name,async()=>{
  const source=body;
  const expected=await execute(source,'virtual');
  assert.notEqual(expected.error,'SyntaxError');
  assert.deepEqual(await execute(rewrite_source(source,['fetch','globalThis']),'physical'),expected);
});
