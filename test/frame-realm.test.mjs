import test from 'node:test';
import assert from 'node:assert/strict';
import {Script,createContext} from 'node:vm';
import realm_wrapper from '../build/frame-realm.cjs';

test('Frame bundles retain private native dependencies while authored globals and indirect eval stay public',()=>{
  const realm=createContext({URL:globalThis.URL});
  const evaluate=source=>new Script(source).runInContext(realm);
  const original=evaluate('globalThis');
  evaluate(realm_wrapper.header+`var sandstone_frame={
    url:()=>new URL('/path','https://site.test/').href,
    keys:value=>Object.keys(value),
    realm:()=>globalThis,
    source:code=>(0,eval)(code)
  };`+realm_wrapper.footer);
  const runtime=realm.sandstone_frame;
  evaluate('function URL(){return "authored URL"}function Object(){return "authored Object"}function eval(){return "authored eval"}function globalThis(){return "authored globalThis"}');
  assert.equal(runtime.url(),'https://site.test/path');assert.deepEqual([...runtime.keys({value:42})],['value']);
  assert.equal(runtime.realm(),original);
  assert.equal(runtime.source('URL()'),'authored URL');assert.equal(runtime.source('Object()'),'authored Object');
  assert.equal(evaluate('eval()'),'authored eval');assert.equal(evaluate('globalThis()'),'authored globalThis');
});

test('Copied runtime bundles capture the receiving realm and retain adapted constructors',()=>{
  const source=realm_wrapper.header+'globalThis.StorageEvent=function AdaptedStorageEvent(){};var sandstone_frame={realm:()=>globalThis,event:()=>StorageEvent};'+realm_wrapper.footer;
  const first=createContext({}),second=createContext({});
  new Script(source).runInContext(first);new Script(source).runInContext(second);
  assert.notEqual(first.sandstone_frame.realm(),second.sandstone_frame.realm());
  assert.equal(first.sandstone_frame.event(),first.StorageEvent);assert.equal(second.sandstone_frame.event(),second.StorageEvent);
});
