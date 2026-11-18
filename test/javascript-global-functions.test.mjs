import test from 'node:test';
import assert from 'node:assert/strict';
import {Script,createContext,constants} from 'node:vm';
import {rewrite_source} from '../src/frame/rewrite/javascript.mjs';
import {create_obj_proxy,bind_native_property} from '../src/frame/global_functions.mjs';
import {globalFunctionCases} from './javascript-global-functions-cases.mjs';

function run(test,rewritten){
  const overlay={fetch:()=> 'initial'},realm=createContext(constants.DONT_CONTEXTIFY),sandbox=realm;
  Object.assign(sandbox,{fetch:()=>rewritten?'physical':'initial'});
  const virtual=create_obj_proxy(overlay,['fetch','eval','globalThis'],sandbox);
  sandbox.__ctx__=virtual;overlay.globalThis=virtual;
  const raw=new Script('globalThis').runInContext(realm),nativeEval=new Script('eval').runInContext(realm);
  overlay.eval=nativeEval;sandbox.__get_this__=value=>value===raw?virtual:value;
  overlay.__publish_global_function__=(name,value)=>{Object.defineProperty(virtual,name,{...Object.getOwnPropertyDescriptor(sandbox,name),value});bind_native_property(virtual,name);return value;};
  const execute=(source,mode)=>{
    if(rewritten)source=rewrite_source(source,['fetch','eval','globalThis'],{module:mode==='module',evalMode:mode==='eval'});
    if(mode==='eval')return Reflect.apply(nativeEval,undefined,[source]);
    if(mode==='module')source='(function(){"use strict";'+source+'})()';
    return new Script(source).runInContext(realm);
  };
  if(test.setup)execute(test.setup);
  const completion=execute(test.source,test.mode);
  execute('globalThis.following=fetch();');
  const target=rewritten?virtual:sandbox;
  return JSON.parse(JSON.stringify({result:target.scopeResult,following:target.following,completion:completion??null}));
}
for(const example of globalFunctionCases)test('Global function declarations match native behavior: '+example.name,()=>{
  assert.deepEqual(run(example,true),run(example,false));
});

test('Anonymous default-exported function families retain module rewriting without global publication',()=>{
  for(const declaration of ['function()','async function()','function*()','async function*()']){
    const output=rewrite_source('export default '+declaration+'{return fetch()}',['fetch'],{module:true});
    assert.match(output,/\(0,__ctx__\.fetch\)/);
    assert.doesNotMatch(output,/__publish_global_function__/);
    assert.doesNotThrow(()=>rewrite_source(output,[],{module:true}));
  }
});
