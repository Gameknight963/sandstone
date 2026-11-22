import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseDeclarativeRefresh} from '../src/vendor/scramjet/refresh.mjs';

// Exercise the production rewrite with a synthetic DOM and clock, without
// loading the frame runtime (which requires a native browser document).
const source=readFileSync(new URL('../src/frame/rewrite/meta.mjs',import.meta.url),'utf8')
  .replace(/^import .*;\r?\n/gm,'').replace('export function rewrite_meta','function rewrite_meta');
const makeRewrite=new Function('ctx','convert_url','loader','parseDeclarativeRefresh','setTimeout',source+'\nreturn rewrite_meta;');
function fixture(content){
  const attributes=new Map([['http-equiv','refresh'],['content',content]]),timers=[],navigations=[];
  const loader={frame_id:42,navigate:(...args)=>navigations.push(args)};
  const rewrite=makeRewrite({location:{href:'https://site.test/deep/page?q=1'},document:{baseURI:'https://assets.test/base/'}},
    (url,base)=>new URL(url,base).href,loader,parseDeclarativeRefresh,(callback,delay)=>timers.push({callback,delay}));
  const meta={getAttribute:name=>attributes.get(name)??null,setAttribute:(name,value)=>attributes.set(name,value)};
  rewrite(meta);return {attributes,timers,navigations,loader};
}

test('Vendored refresh parser handles browser separators, fractions, URL labels and quotes',()=>{
  for(const [content,time,url] of [
    ['0',0,null],[' 12.9 ',12,null],['.5; /next',0,'/next'],
    ['3, URL = "next?q=a;b" ignored',3,'next?q=a;b'],
    ["2 ; uRl= 'next'",2,'next'],['1 next',1,'next'],
    ['4; url=/one;two',4,'/one;two'],['0;url=',0,''],
    ['0; "unterminated',0,'unterminated']
  ]){
    const parsed=parseDeclarativeRefresh(content);
    assert.equal(parsed?.time,time,content);assert.equal(parsed?.url,url,content);
    if(url!==null)assert.equal(content.slice(parsed.urlStart,parsed.urlEnd),url);
  }
  for(const content of ['', 'garbage', '-1;url=/next','+1','1x;url=/next'])assert.equal(parseDeclarativeRefresh(content),null,content);
});

test('Meta refresh ignores malformed content and reloads the current document when no target exists',()=>{
  for(const content of ['',null,'bad','-1'])assert.equal(fixture(content).timers.length,0);
  const {attributes,timers,navigations}=fixture('2');
  assert.equal(attributes.get('http-equiv'),'__refresh');
  assert.equal(timers[0].delay,2000);timers[0].callback();
  assert.deepEqual(navigations,[[42,'https://site.test/deep/page?q=1']]);
});

test('Meta refresh resolves authored targets against baseURI and preserves its requesting frame',()=>{
  const {timers,navigations,loader}=fixture('0; URL = "next"');
  loader.frame_id=99;timers[0].callback();
  assert.deepEqual(navigations,[[42,'https://assets.test/base/next']]);
  assert.equal(fixture('0;url=http://[').timers.length,0);
});

test('Large refresh delays do not overflow into immediate browser navigation',()=>{
  const {timers,navigations}=fixture('2147484;url=/later');
  assert.equal(timers[0].delay,2147483647);timers[0].callback();
  assert.deepEqual(navigations,[]);assert.equal(timers[1].delay,353);
  timers[1].callback();assert.deepEqual(navigations,[[42,'https://assets.test/later']]);
  assert.equal(fixture('9'.repeat(400)).timers.length,0);
});
