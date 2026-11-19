import test from 'node:test';
import assert from 'node:assert/strict';
import {decode_document,decode_document_response,decode_classic_response,decode_stylesheet_response,response_charset} from '../src/text_encoding.mjs';

const ascii=value=>new TextEncoder().encode(value);
const bytes=(prefix,...tail)=>Uint8Array.from([...ascii(prefix),...tail]);

test('Document decoding gives BOMs precedence over HTTP and meta declarations',()=>{
  const utf8=Uint8Array.from([0xef,0xbb,0xbf,...ascii('<meta charset=windows-1251><p>\u00e9')]);
  assert.deepEqual(decode_document(utf8,'text/html; charset=iso-8859-1'),{text:'<meta charset=windows-1251><p>\u00e9',encoding:'UTF-8'});
  assert.deepEqual(decode_document(bytes('<meta charset=utf-8><p>',0xe9),'text/html; charset=ISO-8859-1'),{
    text:'<meta charset=utf-8><p>\u00e9',encoding:'windows-1252'
  });
});

test('HTML meta scanning ignores comments and invalid declarations and handles aliases',()=>{
  const prefix='<!-- <meta charset=utf-8> --><meta content="text/html;charset=utf-8"><META HTTP-EQUIV="content-type" CONTENT="text/html; charset=latin1"><p>';
  assert.deepEqual(decode_document(bytes(prefix,0x80),'text/html; charset=unknown'),{text:prefix+'\u20ac',encoding:'windows-1252'});
  assert.equal(response_charset('text/html; other="value"; charset="utf\\-8"'),'UTF-8');
  assert.equal(response_charset("text/html; charset='utf-8'"),null);
});

test('HTTP charset parameters respect quoted values, escapes, duplicates and empty entries',()=>{
  assert.equal(response_charset('text/html; note="ignore; charset=windows-1251"; charset=Shift_JIS'),'Shift_JIS');
  assert.equal(response_charset('text/html; charset=; charset=windows-1251'),'windows-1251');
  assert.equal(response_charset('text/html; charset="windows-1251'),'windows-1251');
  assert.equal(response_charset('text/html; charset=unknown; charset=utf-8'),null);
});

test('Legacy multibyte documents decode their declared character sets',()=>{
  assert.equal(decode_document(bytes('<meta charset=gb2312><p>',0xd6,0xd0,0xce,0xc4),'text/html').text,'<meta charset=gb2312><p>\u4e2d\u6587');
  assert.equal(decode_document(bytes('<p>',0x93,0xfa,0x96,0x7b),'text/html; charset=Shift_JIS').text,'<p>\u65e5\u672c');
  assert.equal(decode_document(bytes('<p>',0xc7,0xd1,0xb1,0xdb),'text/html',{fallbackEncoding:'EUC-KR'}).text,'<p>\ud55c\uae00');
});

test('HTML fallbacks exclude UTF-16 parents while XML keeps its own declaration and default',()=>{
  assert.equal(decode_document(bytes('<p>',0xe9),'text/html').encoding,'windows-1252');
  assert.equal(decode_document(ascii('<p>plain'),'text/html',{fallbackEncoding:'UTF-16LE'}).text,'<p>plain');
  const prefix='<?xml version="1.0" encoding="ISO-8859-1"?><p>';
  assert.equal(decode_document(bytes(prefix,0xe9),'application/xhtml+xml').text,prefix+'\u00e9');
  assert.equal(decode_document(ascii('<p>\u96ea</p>'),'application/xml',{fallbackEncoding:'windows-1252'}).encoding,'UTF-8');
});

test('Response document decoding honors byte subviews without changing Fetch text semantics',async()=>{
  const buffer=Uint8Array.of(0,0x3c,0x70,0x3e,0xe9,0),input=buffer.subarray(1,5);
  const response=new Response(input,{headers:{'Content-Type':'text/html; charset=windows-1252'}}),copy=response.clone();
  assert.deepEqual(await decode_document_response(response),{text:'<p>\u00e9',encoding:'windows-1252'});
  assert.equal(await copy.text(),'<p>\ufffd');
  assert.deepEqual([...buffer],[0,0x3c,0x70,0x3e,0xe9,0]);
});

test('Classic script bytes use the response charset and BOM before their fallback encoding',async()=>{
  assert.equal(await decode_classic_response(new Response(bytes('const text="',0xe9),{headers:{'Content-Type':'text/javascript;charset=latin1'}}),'Shift_JIS'),'const text="\u00e9');
  assert.equal(await decode_classic_response(new Response(Uint8Array.of(0xef,0xbb,0xbf,...ascii('"\u96ea"')),{headers:{'Content-Type':'text/javascript;charset=windows-1251'}})),'"\u96ea"');
});

test('Stylesheet decoding recognizes exact charset declarations and preserves inherited encoding',async()=>{
  const declared=bytes('@charset "windows-1252";a{content:"',0x80);
  assert.deepEqual(await decode_stylesheet_response(new Response(declared),'windows-1251'),{text:'@charset "windows-1252";a{content:"\u20ac',encoding:'windows-1252'});
  const inherited=await decode_stylesheet_response(new Response(bytes('/*before*/@charset "utf-8";a{content:"',0xe9)),'windows-1252');
  assert.equal(inherited.encoding,'windows-1252');assert.ok(inherited.text.endsWith('\u00e9'));
});
