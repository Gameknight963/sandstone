import test from 'node:test';
import assert from 'node:assert/strict';
import {mime_essence} from '../src/mime.mjs';
import {ModuleLoader} from '../src/frame/modules.mjs';

test('MIME essences use valid tokens, HTTP whitespace and the last valid header value',()=>{
  for(const [value,expected] of [
    [null,null],['',null],[' \tTEXT/JAVASCRIPT \r\n; charset=utf-8','text/javascript'],
    ['text/plain, text/javascript;note="a,b"','text/javascript'],
    ['text/javascript;note="a\\\",b", application/json','application/json'],
    ['text/javascript, garbage, */*,','text/javascript'],
    ['text/javascript, text/plain','text/plain'],['text /javascript',null],
    ['text/ javascript',null],['text/javascript\u00a0',null],['\u000btext/javascript',null],
    ['application/thing+JSON','application/thing+json'],['*/foo+json','*/foo+json'],
    ['application/\u212a+json',null],['text/javascript;note="unfinished\\','text/javascript']
  ])assert.equal(mime_essence(value),expected,JSON.stringify(value));
});

test('Invalid module MIME types cancel unread bodies, cache failures and leave fallback graphs usable',async()=>{
  let cancellations=0,fetches=0,compiles=0,executes=0;
  const loader=new ModuleLoader({
    fetch:async url=>{
      fetches++;
      if(url.endsWith('good.js'))return new Response('export default 42;',{headers:{'Content-Type':'text/javascript'}});
      return new Response(new ReadableStream({cancel(){cancellations++;}}),{headers:{'Content-Type':'text/html'}});
    },rewrite:source=>{compiles++;return source;},createURL:()=> 'blob:local',register(){},execute:()=>{executes++;return 42;}
  });
  for(let index=0;index<2;index++)await assert.rejects(loader.import('./bad.js','https://mime.test/'),{name:'TypeError'});
  assert.equal(cancellations,1);assert.equal(fetches,1);assert.equal(compiles,0);assert.equal(executes,0);
  assert.equal(await loader.import('./good.js','https://mime.test/'),42);
  assert.equal(fetches,2);assert.equal(compiles,1);assert.equal(executes,1);
});
