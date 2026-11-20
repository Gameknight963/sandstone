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

test('Runtime seeds preserve supported XML MIME types and reject other types before creating a URL',async()=>{
  for(const mime of ['image/svg+xml','application/xhtml+xml','application/xml','text/xml']){
    let receive;const created=[],parent={postMessage(){}};
    const url=runtime_seed('xml-secret'),html=decodeURIComponent(url.slice(url.indexOf(',')+1));
    const realm=createContext({parent,Blob,URL:{createObjectURL(blob){created.push(blob);return 'blob:xml/runtime'}},location:{href:url},addEventListener(type,callback){receive=callback;}});
    new Script(html.match(/<script[^>]*>([\s\S]*)<\/script>/)[1]).runInContext(realm);
    const deliver=message=>receive({isTrusted:true,source:parent,data:{sandstone_bootstrap:1,type:'runtime',nonce:'xml-secret',html:'<xml/>',...message},ports:[],stopImmediatePropagation(){}});
    deliver({mime:'image/png'});deliver({mime:'text/html;charset=shift_jis'});deliver({mime,nonce:'wrong'});assert.equal(created.length,0);
    deliver({mime});assert.equal(created.length,1);assert.equal(created[0].type,mime);assert.equal(await created[0].text(),'<xml/>');
  }
});
