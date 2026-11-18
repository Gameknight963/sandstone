import test from 'node:test';
import assert from 'node:assert/strict';
import {script_kind,svg_script_kind} from '../src/frame/script_types.mjs';

test('Script classification recognizes all standard JavaScript MIME essences without accepting MIME parameters',()=>{
  const types=['application/ecmascript','application/javascript','application/x-ecmascript','application/x-javascript','text/ecmascript','text/javascript',...Array.from({length:6},(_,i)=>'text/javascript1.'+i),'text/jscript','text/livescript','text/x-ecmascript','text/x-javascript'];
  for(const type of types){assert.equal(script_kind(type),'classic');assert.equal(script_kind(' \t'+type.toUpperCase()+'\r\n'),'classic');assert.equal(svg_script_kind(type),'classic');assert.equal(script_kind(type+'; charset=utf-8'),null);}
  assert.equal(script_kind('\vtext/javascript\v'),'classic');
  for(const type of [' ','\t\n','\u00a0text/javascript\u00a0','\uFEFFtext/javascript','application/json','text/javascript1.6'])assert.equal(script_kind(type),null);
});

test('HTML language fallback applies only to missing types and does not trim language names',()=>{
  for(const language of [null,'','JavaScript','JavaScript1.5','JScript','LiveScript','ECMAScript'])assert.equal(script_kind(null,language),'classic');
  for(const language of ['vbscript',' JavaScript ','module'])assert.equal(script_kind(null,language),null);
  assert.equal(script_kind('','vbscript'),'classic');assert.equal(script_kind('text/javascript','vbscript'),'classic');
  assert.equal(script_kind(' ','JavaScript'),null);
});

test('Module/import-map keywords are case-insensitive and remain distinct from whitespace-padded data types',()=>{
  for(const kind of ['module','importmap']){assert.equal(script_kind(kind.toUpperCase()),kind);assert.equal(script_kind(' '+kind+' '),null);}
  assert.equal(svg_script_kind('module'),'module');assert.equal(svg_script_kind('importmap'),null);
});
