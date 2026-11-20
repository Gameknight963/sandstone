import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {bootstrap_html,bootstrap_xml,bootstrap_worker,bootstrap_attribute,create_bootstrap_nonce,runtime_seed,runtime_content_type} from '../src/bootstrap.mjs';

test('Bootstrap nonces use native random bytes without requiring randomUUID',()=>{
  let calls=0;
  assert.equal(create_bootstrap_nonce({getRandomValues(bytes){calls++;assert.equal(bytes.length,16);bytes.set(Array.from({length:16},(_,index)=>index*17));return bytes;}}),'00112233445566778899aabbccddeeff');
  assert.equal(calls,1);
});

test('HTML bootstrap binds the existing runtime script without adding executable markup',()=>{
  const source='<!doctype html><head><script type="text/javascript">runtime();</script><script>other();</script>';
  const output=bootstrap_html(source,'first',2);
  const config=html=>JSON.parse(decodeURIComponent(html.match(new RegExp(bootstrap_attribute+'="([^"]+)"'))[1]));
  assert.deepEqual(config(output),{nonce:'first',channels:2});
  const replaced=bootstrap_html(output,'second');
  assert.deepEqual(config(replaced),{nonce:'second',channels:1});
  assert.equal((replaced.match(/data-sandstone-bootstrap/g)||[]).length,1);
  assert.equal((replaced.match(/<script/g)||[]).length,2);
  assert.ok(replaced.includes('type="text/javascript"'));assert.ok(replaced.includes('runtime();</script><script>other();'));
});

test('Worker bootstrap configuration exists before runtime evaluation',()=>{
  const context={};runInNewContext(bootstrap_worker('globalThis.observed=globalThis.__sandstone_bootstrap__;','worker-secret'),context);
  assert.equal(context.observed.nonce,'worker-secret');assert.equal(context.observed.channels,1);
});

test('XML runtime markup retains script text across CDATA terminators and binds its nonce',()=>{
  const source='globalThis.sample="</script>]]>";';
  for(const type of ['image/svg+xml','application/xhtml+xml','application/xml','text/xml','application/rss+xml','application/atom+xml']){
    const markup=bootstrap_xml(source,type,'xml-secret',2);
    const config=JSON.parse(decodeURIComponent(markup.match(/data-sandstone-bootstrap="([^"]+)"/)[1]));
    assert.deepEqual(config,{nonce:'xml-secret',channels:2});
    assert.ok(markup.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    const script=markup.match(/<script[^>]*>([\s\S]*)<\/script>/)[1];
    const text=[...script.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map(match=>match[1]).join('');
    assert.equal(text,source);
    assert.ok(markup.includes(type==='image/svg+xml'?'<svg xmlns="http://www.w3.org/2000/svg">':'<html xmlns="http://www.w3.org/1999/xhtml">'));
  }
  for(const type of ['image/png','application/javascript','text/html;charset=shift_jis','application/mathml+xml','image/x-custom+xml','text/x-custom+xml'])assert.throws(()=>runtime_content_type(type),TypeError);
  assert.throws(()=>bootstrap_xml(source,'text/html','nonce'),TypeError);
});

test('Opaque runtime seeds authenticate parent messages before preparing a bundle URL',async()=>{
  const nonce='0123456789abcdef',url=runtime_seed(nonce),html=decodeURIComponent(url.slice(url.indexOf(',')+1));
  assert.ok(url.length<5000);assert.ok(html.startsWith('<!doctype html>'));
  const parent={postMessage(value){this.reply=value;}};
  let listener,removed=false,closed=0,prepared;
  let navigated;
  const context={parent,location:{href:url,replace(url){navigated=url;}},URL:{createObjectURL(blob){prepared=blob;return 'blob:isolated-runtime';}},Blob,addEventListener(type,callback){listener=callback;},removeEventListener(){removed=true;}};
  runInNewContext(html.match(/<script[^>]*>([\s\S]*)<\/script>/)[1],context);
  const send=(data,options={})=>listener({data,isTrusted:true,source:parent,stopImmediatePropagation(){},ports:[{close(){closed++;}}],...options});
  send({sandstone_bootstrap:1,type:'runtime',nonce,html:'ignored'},{source:{}});assert.equal(prepared,undefined);
  send({sandstone_bootstrap:1,type:'runtime',nonce,html:'ignored'},{isTrusted:false});assert.equal(prepared,undefined);
  send({sandstone_bootstrap:1,type:'ping',id:'probe'});assert.equal(parent.reply.nonce,nonce);assert.equal(parent.reply.url,url);
  send({sandstone_bootstrap:1,type:'runtime',nonce:'wrong',html:'ignored'});assert.equal(prepared,undefined);
  send({sandstone_bootstrap:1,type:'runtime',id:'prepare',nonce,html:'bundle'});assert.equal(await prepared.text(),'bundle');assert.equal(prepared.type,'text/html');assert.equal(parent.reply.type,'runtime_url');assert.equal(parent.reply.id,'prepare');assert.equal(parent.reply.url,'blob:isolated-runtime');assert.equal(removed,false);assert.equal(navigated,undefined);
  send({sandstone_bootstrap:1,type:'commit_runtime',nonce:'wrong',url:'blob:isolated-runtime'});assert.equal(navigated,undefined);
  send({sandstone_bootstrap:1,type:'commit_runtime',nonce,url:'blob:isolated-runtime'});assert.equal(removed,true);assert.equal(navigated,'blob:isolated-runtime');assert.equal(closed,5);
});
