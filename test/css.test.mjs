import test from 'node:test';
import assert from 'node:assert/strict';
import { css_references, decode_css, rewrite_css, prepare_css, restore_css, edit_css_parts } from '../src/frame/css.mjs';

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

test('Imported CSS uses its final URL and delivered referrer policy for its resources', async () => {
  const requests = [], contexts = [];
  const parent = {referrer:'https://site.test/css/root.css',referrerPolicy:'origin'};
  await rewrite_css('@import "child.css"; .root{background:url(root.svg)}', parent.referrer, {
    request: parent,
    async fetch(url, options) {
      requests.push({url, ...options});
      if (url.endsWith('/child.css')) {
        const response = new Response('@import "nested.css"; .child{background:url(child.svg)}', {headers:{'Referrer-Policy':'no-referrer'}});
        Object.defineProperty(response,'url',{value:'https://cdn.test/final/child.css'});
        return response;
      }
      if (url.endsWith('/nested.css')) return new Response('.nested{background:url(nested.svg)}');
      return new Response('image');
    },
    createURL(blob, url, context) { if (context) contexts.push({url,...context}); return 'blob:'+url; }
  });
  assert.deepEqual(requests.find(value=>value.url.endsWith('/root.svg')), {url:'https://site.test/css/root.svg',...parent});
  assert.deepEqual(requests.find(value=>value.url.endsWith('/child.svg')), {url:'https://cdn.test/final/child.svg',referrer:'https://cdn.test/final/child.css',referrerPolicy:'no-referrer'});
  assert.deepEqual(requests.find(value=>value.url.endsWith('/nested.svg')), {url:'https://cdn.test/final/nested.svg',referrer:'https://cdn.test/final/nested.css',referrerPolicy:'strict-origin-when-cross-origin'});
  assert.equal(requests.find(value=>value.url.endsWith('/nested.css')).referrerPolicy,'no-referrer');
  assert.ok(contexts.some(value=>value.url.endsWith('/child.css')&&value.referrerPolicy==='no-referrer'));
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

test('Synchronous CSS placeholders retain syntax and restore only resource tokens', () => {
  const source='@import "theme.css" layer(theme) supports(display:grid); .x{background:url(a.png);content:"url(a.png)";mask:url(#id)}';
  const prepared=prepare_css(source,'pending-',()=>true);
  assert.doesNotMatch(prepared.css, /supports\(display:grid\)/);
  assert.equal(prepared.markers.size,2);
  assert.match(prepared.css, /data:text\/css,\/\*pending-0\*\//);
  assert.match(prepared.css, /data:application\/octet-stream,pending-1/);
  const restored=restore_css(prepared.css,prepared.markers);
  assert.deepEqual(css_references(restored).map(reference=>reference.url),['theme.css','a.png','#id']);
  assert.match(restored,/layer\(theme\)/);
  assert.match(restored,/content:"url\(a.png\)"/);
});

test('CSS token edits preserve text node boundaries even when URLs cross every split', async () => {
  const source='@import "theme.css" supports(display:grid); .x {background:url("one.svg"); color:red}';
  for (let split=0; split<=source.length; split++) {
    const parts=[source.slice(0,split),'',source.slice(split)];
    const prepared=prepare_css(source,'parts-',()=>true);
    const safe=edit_css_parts(parts,prepared.edits);
    assert.equal(safe.join(''),prepared.css);
    const restored=restore_css(safe.join(''),prepared.markers,edits=>edit_css_parts(safe,edits));
    assert.equal(restored.length,parts.length);
    assert.equal(restored.join(''),restore_css(prepared.css,prepared.markers));
    const resolved=await rewrite_css(source,'https://site.test/',{
      supports:()=>true,fetch:async()=>new Response(''),createURL:()=> 'blob:local',
      transform:(source,edits)=>edit_css_parts(parts,edits)
    });
    assert.equal(resolved.length,parts.length);
    assert.equal(resolved.join(''),'@import "blob:local" ; .x {background:url("blob:local"); color:red}');
  }
});

test('CSS URLs accepted at EOF stay on the relay and retain their unfinished syntax', async () => {
  const cases = ['.x{background:url(one.svg', '.x{background:url("one.svg',
    '.x{background:url("one.svg"', '.x{background:url(one.svg  ',
    '@import "one.svg', '@import url(one.svg'];
  for (const source of cases) {
    const references = css_references(source);
    assert.equal(references.length, 1); assert.equal(references[0].url, 'one.svg');
    const prepared = prepare_css(source, 'eof-');
    assert.equal(restore_css(prepared.css, prepared.markers), source);
    const requested = [];
    const resolved = await rewrite_css(source, 'https://site.test/', {
      async fetch(url) { requested.push(url); return new Response(''); }, createURL: () => 'blob:local'
    });
    assert.deepEqual(requested, ['https://site.test/one.svg']);
    assert.equal(css_references(resolved)[0].url, 'blob:local');
    assert.equal(css_references(resolved)[0].ending, references[0].ending);
  }
  const partial = '.x{background:url("partial';
  const prepared = prepare_css(partial, 'continuation-');
  const continued = prepared.css + '.svg")}';
  assert.equal(restore_css(continued, prepared.markers, undefined, true), '.x{background:url("partial.svg")}');
  assert.equal(css_references('.x{background:url("bad\nstring.svg")}').length, 0);
});
