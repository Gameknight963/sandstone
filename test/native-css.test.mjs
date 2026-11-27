import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInThisContext} from 'node:vm';
import {create_css_bridge} from '../src/native/css_bridge.mjs';
import {initialize_native_css,native_css_status} from '../src/native/css.mjs';
import {css_references,css_resource_references,prepare_css,restore_css,restore_css_parts,edit_css_parts,rewrite_css} from '../src/frame/css.mjs';
import {fixtures} from '../bench/wasm-css/verify.mjs';
import {srcset_urls,rewrite_srcset} from '../src/frame/srcset.mjs';

const bytes=await readFile(new URL('../vendor/native/css.wasm',import.meta.url));
test('Native CSS matches JS scanning, conditional preparation, restoration and text-node edits',async()=>{
  const core=await create_css_bridge(bytes);
  for(const source of await fixtures()){
    assert.deepEqual(core.scan(source),css_references(source));
    for(const accepted of [false,true]){
      const actualCalls=[],expectedCalls=[];
      const expected=prepare_css(source,'native-',condition=>{expectedCalls.push(condition);return accepted;});
      const actual=core.prepare(source,'native-',condition=>{actualCalls.push(condition);return accepted;});
      assert.deepEqual(actual,expected);assert.deepEqual(actualCalls,expectedCalls);
      assert.equal(core.restoreWithPrefixes(actual.css,actual.markers,false,true).css,restore_css(expected.css,expected.markers,undefined,true));
      const parts=[];for(let i=0;i<actual.css.length;i+=7)parts.push(actual.css.slice(i,i+7));
      assert.deepEqual(core.restoreParts(parts,actual.markers,true),restore_css_parts(parts,expected.markers,true));
    }
  }
});
test('Native responsive-image parsing and assembly preserve descriptors, commas and UTF-16',async()=>{
  const core=await create_css_bridge(bytes);
  const cases=[...await fixtures(),'a.png 1x, data:image/svg+xml,a,b 2x, next.png,,, last.png','invalid.png future(a,b), valid.png 400w 200h'];
  for(const source of cases){
    const refs=srcset_urls(source);assert.deepEqual(core.srcset(source),refs);
    const values=refs.map((_,index)=>'blob:srcset-'+index+'#雪');let index=0;
    assert.equal(core.applySrcset(source,values).value,await rewrite_srcset(source,async()=>values[index++]));
  }
});
test('Application CSS and srcset paths activate for large inputs and keep small calls in JS',async()=>{
  const source='@import "theme.css" supports(display:grid);.x{background:url(icon.svg)}\n'.repeat(90);
  const expected=prepare_css(source,'active-',()=>true),expectedScan=css_references(source);
  const images=Array.from({length:500},(_,index)=>'pixel.svg '+(index+1)+'w').join(', '),expectedImages=srcset_urls(images);
  assert.equal(await initialize_native_css(bytes),true);
  const before=native_css_status().calls;
  assert.deepEqual(css_references(source),expectedScan);
  const prepared=prepare_css(source,'active-',()=>{
    // Reentrant CSS work must stay in JS while the C++ stack owns its buffers.
    assert.deepEqual(css_references(source),expectedScan);return true;
  });
  assert.deepEqual(prepared,expected);
  assert.deepEqual(Object.keys(prepared),Object.keys(expected));
  const parts=[prepared.css.slice(0,3),prepared.css.slice(3)];
  assert.deepEqual(restore_css_parts(parts,prepared.markers,true),restore_css(prepared.css,prepared.markers,edits=>edit_css_parts(parts,edits),true));
  let after=native_css_status().calls;
  assert.ok(after.scan>before.scan);assert.equal(after.prepare,before.prepare+1);
  assert.ok(after.restoreParts>before.restoreParts);assert.ok(after.restore>before.restore);
  assert.deepEqual(srcset_urls(images),expectedImages);
  assert.equal(await rewrite_srcset(images,async url=>'blob:'+url),images.replaceAll('pixel.svg','blob:pixel.svg'));
  assert.ok(native_css_status().calls.srcset>0);assert.ok(native_css_status().calls.applySrcset>0);
  after=native_css_status().calls;
  css_references('a{background:url(a)}');prepare_css('a{}','short-');
  srcset_urls('tiny.png 1x');await rewrite_srcset('tiny.png 1x',async url=>url);
  assert.deepEqual(native_css_status().calls,after);
});
test('Native memory growth preserves input, returned strings and split-node edits',async()=>{
  const core=await create_css_bridge(bytes),before=core.memory_bytes();
  const source='.x{background:url(icon.svg)}\n'.repeat(20000);
  const prepared=core.prepare(source,'growth-');
  assert.equal(prepared.markers.size,20000);assert.ok(core.memory_bytes()>before);
  const expected='.x{background:url("icon.svg")}\n'.repeat(20000);
  assert.equal(core.restoreWithPrefixes(prepared.css,prepared.markers,false,true).css,expected);
  const parts=[];for(let i=0;i<prepared.css.length;i+=8192)parts.push(prepared.css.slice(i,i+8192));
  assert.equal(core.restoreParts(parts,prepared.markers,true).join(''),expected);
  assert.equal(prepared.markers.size,20000);
});
test('A failed native initialization retains the synchronous fallback',async()=>{
  const isolated=await import('../src/native/css.mjs?invalid-binary');
  assert.equal(await isolated.initialize_native_css(new Uint8Array([0,1,2])),false);
  assert.equal(isolated.native_css_status().ready,false);
  assert.equal(isolated.native_css_references('x'.repeat(8192)),null);
});
test('Resolved stylesheet assembly matches transforms and preserves conditional imports',async()=>{
  const source=('.x{background:url(icon.svg);mask:url(mask.svg#part)}\n').repeat(100);
  const services={async fetch(){return new Response('image')},createURL:()=> 'blob:resolved'};
  const expected=await rewrite_css(source,'https://fixture.test/',{...services,transform:(text,edits)=>{
    for(const {start,end,value}of edits.sort((a,b)=>b.start-a.start))text=text.slice(0,start)+value+text.slice(end);return text;
  }});
  const before=native_css_status().calls.apply;
  assert.equal(await rewrite_css(source,'https://fixture.test/',services),expected);
  assert.equal(native_css_status().calls.apply,before+1);
  const conditional='@import "yes.css" supports(display:grid);@import "no.css" supports(unknown:x);'.repeat(80);
  const options={...services,supports:condition=>condition==='display:grid'};
  const render=(text,edits)=>{for(const {start,end,value}of edits.sort((a,b)=>b.start-a.start))text=text.slice(0,start)+value+text.slice(end);return text;};
  assert.equal(await rewrite_css(conditional,'https://fixture.test/',options),await rewrite_css(conditional,'https://fixture.test/',{...options,transform:render}));
  const core=await create_css_bridge(bytes);
  const module=await readFile(new URL('../src/frame/css.mjs',import.meta.url),'utf8');
  const token=runInThisContext('('+module.slice(module.indexOf('function resource_token('),module.indexOf('export function css_resource_references(')).trim()+')');
  for(const input of await fixtures()){
    const references=css_resource_references(input),values=references.map((_,index)=>'blob:native-'+index+'#雪');
    const supported=references.map(ref=>!!ref.condition),edits=[];
    for(let i=0;i<references.length;i++){
      const ref=references[i];edits.push({start:ref.start,end:ref.end,value:token(ref,values[i])});
      if(supported[i])edits.push({start:ref.condition_start,end:ref.condition_end,value:''});
    }
    assert.equal(core.apply(input,values,supported).css,render(input,edits));
  }
});
test('Supports callback exceptions propagate once and retire the native instance',()=>{
  const source=('@import "x.css" supports(display:grid);').repeat(150),sentinel={toString(){throw new Error('Must not coerce callback errors')}};
  let count=0;
  assert.throws(()=>prepare_css(source,'throw-',()=>{count++;throw sentinel;}),error=>error===sentinel);
  assert.equal(count,1);assert.equal(native_css_status().ready,false);
  assert.ok(prepare_css(source,'fallback-',()=>false).css.includes('data:text/css,'));
});
