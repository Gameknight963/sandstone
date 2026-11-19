import test from 'node:test';
import assert from 'node:assert/strict';
import {encoding_parse_url} from '../src/url_encoding.mjs';

const base='https://site.test/base/path?inherited=%D2#old';
test('HTML URL parsing applies a legacy encoding only to new queries',()=>{
  assert.equal(encoding_parse_url('/Тест?q=Тест&snow=雪#Тест',base,'windows-1251').href,'https://site.test/%D0%A2%D0%B5%D1%81%D1%82?q=%D2%E5%F1%F2&snow=%26%2338634%3B#%D0%A2%D0%B5%D1%81%D1%82');
  for(const value of ['', '#fragment?Тест', '../next', '?', '?already=%D2%E5&literal=%zz'])assert.equal(encoding_parse_url(value,base,'windows-1251').href,new URL(value,base).href);
  assert.equal(encoding_parse_url(' \t/?q=Т\nест\r \u0000',base,'windows-1251').href,'https://site.test/?q=%D2%E5%F1%F2');
  assert.equal(encoding_parse_url('/?q=\u0000 "<>\'`&x=1',base,'windows-1251').search,'?q=%00%20%22%3C%3E%27`&x=1');
});
test('HTML URL encoding preserves opaque URLs and UTF-8 output encodings',()=>{
  for(const encoding of ['UTF-8','UTF-16LE','UTF-16BE','replacement','unknown'])assert.equal(encoding_parse_url('/?q=雪',base,encoding).href,new URL('/?q=雪',base).href);
  for(const value of ['data:text/plain,?q=雪','custom:path?q=雪','mailto:name@site.test?q=雪'])assert.equal(encoding_parse_url(value,base,'windows-1251').href,new URL(value,base).href);
  for(const value of ['ws://site.test/','wss://site.test/','custom://site.test/','custom://','custom:/path'])assert.equal(encoding_parse_url(value+'?q=Тест',base,'windows-1251').search,'?q=%D2%E5%F1%F2');
});
test('HTML URL encoding retains native coercion order and invalid URL errors',()=>{
  const calls=[];
  assert.equal(encoding_parse_url({toString(){calls.push('input');return '?q=é';}},{toString(){calls.push('base');return base;}},'windows-1252').search,'?q=%E9');
  assert.deepEqual(calls,['input','base']);
  assert.throws(()=>encoding_parse_url(Symbol(),base,'windows-1251'),TypeError);
  assert.throws(()=>encoding_parse_url('http://[',base,'windows-1251'),TypeError);
});
