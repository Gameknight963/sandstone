import test from 'node:test';
import assert from 'node:assert/strict';
import {content_disposition,download_filename,is_download} from '../src/download.mjs';
import {Downloads} from '../src/host/download.mjs';

test('Download filenames parse quoted parameters and prefer valid extended Unicode names',()=>{
  assert.equal(download_filename('https://site.test/','attachment; filename="a;b.txt"'),'a;b.txt');
  assert.equal(download_filename('https://site.test/','attachment; filename="a\\"b.txt"'),'a"b.txt');
  assert.equal(download_filename('https://site.test/','attachment; filename="fallback.txt"; filename*=UTF-8\'en\'caf%C3%A9.txt'),'café.txt');
  assert.equal(download_filename('https://site.test/','attachment; filename*=ISO-8859-1\'\'caf%E9.txt'),'café.txt');
  assert.equal(download_filename('https://site.test/','attachment; filename="fallback.txt"; filename*=UTF-8\'\'%ZZ'),'fallback.txt');
  assert.equal(content_disposition('INLINE; filename="report.txt"').attachment,false);
  assert.equal(content_disposition('custom; filename="report.txt"').attachment,true);
});

test('Download filename precedence uses headers, author hints and final URL components safely',()=>{
  assert.equal(download_filename('https://site.test/','attachment; filename="caf%C3%A9%20report.txt"'),'caf\u00e9 report.txt');
  assert.equal(download_filename('https://site.test/',null,'caf%C3%A9.txt'),'caf%C3%A9.txt');
  assert.equal(download_filename('https://site.test/final%20name.txt?q=secret#hash',null,''),'final name.txt');
  assert.equal(download_filename('https://site.test/file.bin',null,'author.txt'),'author.txt');
  assert.equal(download_filename('https://site.test/file.bin','attachment; filename="server.txt"','author.txt'),'server.txt');
  assert.equal(download_filename('https://site.test/','attachment; filename="../private/report.txt"'),'report.txt');
  assert.equal(download_filename('data:text/plain,private',null,''),'download');
  assert.equal(download_filename('https://site.test/',null,'..'),'download');
  assert.equal(download_filename('https://site.test/',null,'bad\0name.txt'),'badname.txt');
});

test('Attachment and binary document types download while renderable document types remain inline',()=>{
  for(const type of ['application/octet-stream','application/zip','text/csv;charset=UTF-8','application/vnd.openxmlformats-officedocument.wordprocessingml.document'])assert.equal(is_download(new Headers({'Content-Type':type})),true,type);
  for(const type of ['text/html','text/plain','application/json','image/png','application/pdf'])assert.equal(is_download(new Headers({'Content-Type':type})),false,type);
  assert.equal(is_download(new Headers({'Content-Disposition':'attachment','Content-Type':'text/plain'})),true);
});

test('Relayed downloads retain their original document after context retirement and select server filenames',async()=>{
  const contexts=new Map([['document',{context:{url:'https://site.test/page',top_url:'https://site.test/'}}]]);
  let respond,seen,saved;
  const downloads=new Downloads({contexts,fetch:async(url,options,context)=>{seen={url,options,context};return new Promise(resolve=>{respond=resolve;});},save:(blob,name)=>{saved={blob,name};}});
  const pending=downloads.request('document','https://site.test/file','author.txt',{referrerPolicy:'no-referrer',referrer:'https://site.test/current'});
  contexts.delete('document');respond(new Response(new Uint8Array([0,1,255]),{headers:{'Content-Disposition':'attachment; filename="server.bin"','Content-Type':'application/octet-stream'}}));
  assert.equal((await pending).filename,'server.bin');assert.equal(saved.name,'server.bin');assert.deepEqual([...new Uint8Array(await saved.blob.arrayBuffer())],[0,1,255]);
  assert.equal(seen.context.url,'https://site.test/page');assert.equal(seen.context.navigation,true);assert.equal(seen.options.credentials,'include');assert.equal(seen.options.referrerPolicy,'no-referrer');assert.equal(seen.options.referrer,'https://site.test/current');
});

test('Download broker rejects unknown documents and remote non-HTTP URLs and validates Blob payloads',async()=>{
  const downloads=new Downloads({contexts:new Map([['document',{context:{url:'https://site.test/'}}]]),fetch:async()=>new Response('error',{status:404}),save:()=>assert.fail('Must not save')});
  await assert.rejects(downloads.request('missing','https://site.test/'),TypeError);
  await assert.rejects(downloads.request('document','file:///local'),TypeError);
  await assert.rejects(downloads.request('document','https://site.test/'),/404/);
  await assert.rejects(downloads.blob('document','not a blob','name.txt'),TypeError);
});
