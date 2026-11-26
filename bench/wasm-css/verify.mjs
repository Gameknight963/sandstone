import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {parse} from 'acorn';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {css_references, prepare_css} from '../../src/frame/css.mjs';
import {loadWasm} from './bridge.mjs';

export async function fixtures(){
  const cases=new Set(['', 'url(', 'url("', '@import "', 'url(a\\',
    '@import "a" supports();', '@import url(a) supports(background:url(feature));',
    '@namespace svg url(namespace); @font-face{src:url(font)}',
    '.\ud800{background:url("\udfff");content:"😀"}',
    '\ufeff'+'.x{background:url(a)}'.repeat(20),
    '.x{background:url(a)}'.repeat(20)+'\ud800',
    '.x{background:url("'+ 'a'.repeat(140)+'\udfff")}',
    'a{background:image-set("one" 1x type("image/png"),url(two) 2x)}']);
  // Reuse every literal from the existing CSS tests, including malformed EOF
  // cases. Interpolated templates are covered by deterministic fuzzing below.
  for(const name of await readdir(new URL('../../test/',import.meta.url))){
    if(!name.includes('css')||!name.endsWith('.test.mjs'))continue;
    const ast=parse(await readFile(new URL('../../test/'+name,import.meta.url),'utf8'),{ecmaVersion:'latest',sourceType:'module'});
    function visit(node){
      if(!node||typeof node!=='object')return;
      if(node.type==='Literal'&&typeof node.value==='string')cases.add(node.value);
      if(node.type==='TemplateLiteral'&&!node.expressions.length)cases.add(node.quasis[0].value.cooked??node.quasis[0].value.raw);
      for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);
    }
    visit(ast);
  }
  let seed=0x51ad;
  const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  const pieces=['url(a.png)','URL("😀/雪.png")','u\\72l(a\\20 b.svg)', '@import "a.css" layer(x) supports(display:grid);',
    '@import url(x) supports(background:url(feature));','@font-face{src:url(font.woff2)}','image-set("one" 1x type("image/png"),url(two) 2x)',
    '/* url(ignored) */','"url(ignored)"','url(data:image/png,a)','url(#id)','\\','(',')','{','}',';',':','\r\n','\ud800','\udfff','url("broken\n','url(EOF  /* tail */'];
  for(let i=0;i<2500;i++){
    let source='';for(let j=random(30)+1;j>0;j--)source+=pieces[random(pieces.length)];
    if(i%2)source=source.slice(0,random(source.length+1));cases.add(source);
  }
  return [...cases];
}

export function check(wasm,source,label){
  assert.deepEqual(wasm.scan(source),css_references(source),label+' scan');
  for(const prefix of ['sandstone-wasm-','😀 "\\\n\ud800'])
    assert.deepEqual(wasm.prepare(source,prefix),prepare_css(source,prefix),label+' prepare');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const wasm=await loadWasm(await readFile(new URL('../../.temp/wasm-css/css.wasm',import.meta.url)));
  const cases=await fixtures();
  for(const [i,source]of cases.entries())check(wasm,source,JSON.stringify({i,source}));
  console.log(`Exact JS/WASM parity: ${cases.length} inputs, scanner plus rewriting with two prefixes.`);
}
