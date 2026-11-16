import test from 'node:test';
import assert from 'node:assert/strict';
import { css_references, decode_css, rewrite_css } from '../src/frame/css.mjs';

test('CSS resource tokens respect comments, strings, escapes and image-set type hints', () => {
  const source = String.raw`/* url(ignore.png) */
    @import /* comment */ "theme.css" layer(theme) supports(display: grid) screen;
    .x { content: 'url(ignore-too.png)'; background: URL( "image (one).png" );
      mask: u\72l(vector.svg\#shape); cursor: url(cursor\).png), auto;
      background-image: image-set('one.png' 1x type('image/png'), url(two.png) 2x);
    }`;
  assert.deepEqual(css_references(source).map(({url, imported}) => ({url, imported})), [
    {url:'theme.css',imported:true}, {url:'image (one).png',imported:false},
    {url:'vector.svg#shape',imported:false}, {url:'cursor).png',imported:false},
    {url:'one.png',imported:false}, {url:'two.png',imported:false}
  ]);
  assert.equal(decode_css(String.raw`a\20 b\00002e png`), 'a b.png');
  assert.equal(decode_css('a\\\nb'), 'ab');
});

test('CSS imports resolve against redirected stylesheet URLs and preserve conditions', async () => {
  const requested=[];
  const blobs=new Map();
  const services={
    async fetch(url) {
      requested.push(url);
      if(url==='https://site.test/css/theme.css') {
        const response=new Response('@import "nested.css"; .imported { background: url(../images/icon.svg#mark) }');
        Object.defineProperty(response,'url',{value:'https://cdn.test/styles/theme.css'});
        return response;
      }
      if(url==='https://cdn.test/styles/nested.css') return new Response('.nested { color: red }');
      return new Response('resource');
    },
    createURL(blob,url) { const key='blob:'+url; blobs.set(key,blob); return key; }
  };
  const result=await rewrite_css('@import "theme.css" layer(theme) supports(display: grid) screen; .a{background:url(./a.png)}', 'https://site.test/css/root.css', services);
  assert.match(result, /@import "blob:https:\/\/cdn.test\/styles\/theme.css" layer\(theme\) supports\(display: grid\) screen/);
  const imported=await blobs.get('blob:https://cdn.test/styles/theme.css').text();
  assert.match(imported, /@import "blob:https:\/\/cdn.test\/styles\/nested.css"/);
  assert.match(imported, /url\("blob:https:\/\/cdn.test\/images\/icon.svg#mark"\)/);
  assert.deepEqual(requested.sort(), ['https://site.test/css/theme.css','https://site.test/css/a.png',
    'https://cdn.test/styles/nested.css','https://cdn.test/images/icon.svg'].sort());
  assert.equal(blobs.get('blob:https://cdn.test/styles/theme.css').type,'text/css');
});

test('CSS import cycles terminate and failed resources cannot fall through to remote URLs', async () => {
  const blobs=[];
  const calls=[];
  const services={
    async fetch(url) {
      calls.push(url);
      if(url.endsWith('child.css')) return new Response('@import "root.css"; .child {color:blue}');
      if(url.endsWith('throw.png')) throw new TypeError('offline');
      return new Response('',{status:404});
    },
    createURL(blob) { blobs.push(blob); return 'blob:local-'+blobs.length; }
  };
  const source='@import url(child.css); @import "missing.css"; .x {background:url(missing.png); mask:url(throw.png)}';
  const result=await rewrite_css(source,'https://site.test/root.css',services,new Set(['https://site.test/root.css']));
  assert.match(await blobs[0].text(), /@import "data:text\/css,"/);
  assert.doesNotMatch(result,/missing|throw/);
  assert.match(result,/data:application\/octet-stream,/);
  assert.equal(calls.filter(url=>url.endsWith('root.css')).length,0);
});

test('CSS local references stay synchronous and repeated resource fetches are deduplicated', async () => {
  const local='@namespace svg url(http://www.w3.org/2000/svg); .x {mask:url(#id); background:url("data:image/svg+xml,(a,b)")}';
  assert.equal(rewrite_css(local,'https://site.test/',{fetch(){throw new Error('unexpected');}}),local);
  let calls=0;
  const result=await rewrite_css('.x{background:url(a.svg#first),url(a.svg#second)}','https://site.test/',{
    async fetch(){calls++;return new Response('svg');}, createURL(){return 'blob:one';}
  });
  assert.equal(calls,1);
  assert.match(result,/blob:one#first/);
  assert.match(result,/blob:one#second/);
});

test('Conditional imports can be evaluated without relying on native import supports syntax', async () => {
  let calls=0;
  const source='@import "yes.css" layer(theme) supports((display: grid) and (selector(:is(a,b)))) screen; @import url(no.css) supports(unknown:value);';
  const result=await rewrite_css(source,'https://site.test/',{
    supports:condition=>condition.startsWith('(display:'),
    async fetch(){calls++;return new Response('.x{}');}, createURL(){return 'blob:local';}
  });
  assert.equal(calls,1);
  assert.match(result, /@import "blob:local" layer\(theme\)  screen;/);
  assert.match(result, /@import url\("data:text\/css,"\) supports\(unknown:value\);/);
  const query=await rewrite_css('@import "yes.css" supports(background: url(unused.png));','https://site.test/',{
    supports:()=>true, async fetch(url){assert.equal(url,'https://site.test/yes.css');return new Response('.x{}');}, createURL(){return 'blob:query';}
  });
  assert.equal(query,'@import "blob:query" ;');
});
