import test from 'node:test';
import assert from 'node:assert/strict';
import {form_encoding,form_pairs,form_urlencoded,form_plaintext,form_multipart} from '../src/form_encoding.mjs';

test('Form encoding selects valid labels and maps non-output encodings to UTF-8',()=>{
  assert.equal(form_encoding('invalid latin1','Shift_JIS'),'windows-1252');
  assert.equal(form_encoding('invalid','Shift_JIS'),'Shift_JIS');
  assert.equal(form_encoding('UTF-16LE windows-1251'),'UTF-8');
});
test('Legacy URL-encoded forms escape bytes and unrepresentable scalar values',()=>{
  assert.equal(form_urlencoded([['q','caf\u00e9 \u96ea \ud83d\ude00']],'windows-1252'),'q=caf%E9+%26%2338634%3B+%26%23128512%3B');
  assert.equal(form_urlencoded([['q','\u4e2d\u6587']],'GBK'),'q=%D6%D0%CE%C4');
  assert.equal(form_urlencoded([['q','\u65e5\u672c']],'Shift_JIS'),'q=%93%FA%96%7B');
});
test('Plain-text and multipart forms preserve legacy bytes and binary file contents',async()=>{
  const data=new FormData();data.append('text\nkey','caf\u00e9\n\u96ea');data.append('file',new File([Uint8Array.of(0,255)],'caf\u00e9.txt'));
  const pairs=form_pairs(data),plain=form_plaintext(pairs,'windows-1252');
  assert.equal(Buffer.from(plain).toString('latin1'),'text\r\nkey=caf\u00e9\r\n&#38634;\r\nfile=caf\u00e9.txt\r\n');
  const body=form_multipart(data,'windows-1252'),bytes=Buffer.from(await body.arrayBuffer());
  assert.ok(bytes.includes(Buffer.from('name="text%0D%0Akey"\r\n\r\ncaf\xe9\r\n&#38634;','latin1')));
  assert.ok(bytes.includes(Buffer.from('filename="caf\xe9.txt"','latin1')));assert.ok(bytes.includes(Buffer.from([0,255])));
  assert.equal(data.get('text\nkey'),'caf\u00e9\n\u96ea');
});

test('Form file serialization uses native metadata rather than authored File subclass getters',async()=>{
  class Upload extends File{get name(){return 'authored';}get type(){return 'authored/type';}}
  const data=new FormData();data.append('file',new Upload(['payload'],'original.txt',{type:'text/plain'}));
  assert.deepEqual(form_pairs(data),[['file','original.txt']]);
  const body=await form_multipart(data,'UTF-8').text();
  assert.ok(body.includes('filename="original.txt"\r\nContent-Type: text/plain\r\n'));assert.ok(body.includes('payload'));
});
