import test from 'node:test';
import assert from 'node:assert/strict';
import {Script,createContext} from 'node:vm';
import {runtime_seed} from '../src/bootstrap.mjs';

test('Serialized runtime seeds execute independently and authenticate installation before navigation',async()=>{
  let receive;const replies=[],created=[],navigated=[],removed=[];
  const parent={postMessage(message,origin){replies.push({message,origin})}},url=runtime_seed('nonce');
  const html=decodeURIComponent(url.slice(url.indexOf(',')+1)),source=html.match(/<script[^>]*>([\s\S]*)<\/script>/)[1];
  const realm=createContext({parent,Blob,URL:{createObjectURL(blob){created.push(blob);return 'blob:seed/runtime'}},location:{href:url,replace(value){navigated.push(value)}},addEventListener(type,listener){assert.equal(type,'message');receive=listener},removeEventListener(type,listener){removed.push([type,listener])}});
  new Script(source).runInContext(realm);
  const deliver=(data,{trusted=true,source=parent}={})=>receive({data,isTrusted:trusted,source,ports:[],stopImmediatePropagation(){}});
  const install={sandstone_bootstrap:1,type:'runtime',nonce:'nonce',id:'install',html:'<!doctype html><body>Runtime'};
  deliver(install,{trusted:false});deliver(install,{source:{}});deliver({...install,nonce:'wrong'});assert.equal(created.length,0);
  deliver(install);assert.equal(created.length,1);assert.equal(await created[0].text(),install.html);assert.equal(navigated.length,0);
  assert.equal(replies[0].message.type,'runtime_url');assert.equal(replies[0].message.url,'blob:seed/runtime');
  deliver({sandstone_bootstrap:1,type:'commit_runtime',nonce:'nonce',url:'blob:wrong'});assert.equal(navigated.length,0);
  deliver({sandstone_bootstrap:1,type:'commit_runtime',nonce:'nonce',url:'blob:seed/runtime'});assert.deepEqual(navigated,['blob:seed/runtime']);assert.equal(removed[0][1],receive);
});
