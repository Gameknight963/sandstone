import test from 'node:test';
import assert from 'node:assert/strict';
import {rewrite_source} from '../src/frame/rewrite/javascript.mjs';

test('Virtual script labels preserve authored directives and ignore directive-like strings',()=>{
  const url='https://fixture.test/assets/main.js';
  for(const directive of ['//# sourceURL=https://authored.test/app.js','//@ sourceURL=legacy.js','//# sourceURL= https://authored.test/spaced.js  ']){
    const source='globalThis.value=1;\n'+directive;
    assert.equal(rewrite_source(source,[],{sourceURL:url}),source);
  }
  for(const source of ['const text="//# sourceURL=fake.js";','const text=`//# sourceURL=fake.js`;','/* sourceURL=fake.js */','//# sourceURL=']){
    assert.ok(rewrite_source(source,[],{sourceURL:url}).endsWith('//# sourceURL='+url+'\n'));
  }
  assert.equal(rewrite_source('const a=1;',[]),'const a=1;');
});

test('Virtual script labels cannot inject another line of executable source',()=>{
  const output=rewrite_source('globalThis.value=1;',[],{sourceURL:'https://fixture.test/main.js\nthrow 42;\u2028throw 43;'});
  assert.equal(output.split('\n').length,3);
  assert.doesNotThrow(()=>new Function(output));
});
