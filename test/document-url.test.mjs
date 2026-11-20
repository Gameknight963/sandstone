import test from 'node:test';
import assert from 'node:assert/strict';
import {opened_document_urls,document_request_url} from '../src/host/document_url.mjs';

const origin='https://editor.test',blob='blob:null/preview';
function fixture(){
  const contexts=new Map([['creator',{context:{url:origin+'/',cookie_url:blob,referrer_url:blob,broadcast_origin:origin}}]]);
  return {contexts,open:snapshot=>opened_document_urls(snapshot,origin,contexts)};
}

test('Opened HTTP and inherited documents retain their URL and cookie origins',()=>{
  const {open}=fixture();
  const http=open({url:origin+'/written'});assert.equal(http.url.href,origin+'/written');assert.equal(http.cookie_url,undefined);
  const blank=open({url:'about:blank',cookie_url:origin+'/page'});assert.equal(blank.cookie_url,origin+'/page');assert.equal(blank.inherited_url,origin+'/page');assert.equal(blank.referrer_url,'about:blank');
  for(const snapshot of [{url:'https://other.test/'},{url:origin+'/written',cookie_url:'https://other.test/'},{url:'about:srcdoc',cookie_url:'https://other.test/'}])assert.throws(()=>open(snapshot),{name:'SecurityError'});
});

test('Blob-written documents require a known creator URL and a matching virtual origin',()=>{
  const {contexts,open}=fixture(),snapshot={url:blob,source_context:'creator'};
  const opened=open(snapshot);assert.equal(opened.url.href,blob);assert.equal(opened.cookie_url,blob);assert.equal(opened.referrer_url,blob);
  assert.equal(open({...snapshot,url:blob+'#preview'}).url.href,blob+'#preview');
  const inherited=open({url:'about:blank',cookie_url:blob,source_context:'creator'});assert.equal(inherited.cookie_url,blob);
  for(const value of [{url:blob},{...snapshot,source_context:'unknown'},{...snapshot,url:'blob:null/unknown'},{...snapshot,cookie_url:'blob:null/unknown'}])assert.throws(()=>open(value),{name:'SecurityError'});
  contexts.get('creator').context.broadcast_origin='https://other.test';assert.throws(()=>open(snapshot),{name:'SecurityError'});
  contexts.get('creator').context.broadcast_origin='opaque:creator';assert.throws(()=>open(snapshot),{name:'SecurityError'});
  contexts.get('creator').context={url:origin+'/ordinary',broadcast_origin:origin};assert.throws(()=>open(snapshot),{name:'SecurityError'});
});

test('Accepted Blob document updates can use a retained creator context without extending its lifetime',()=>{
  const {contexts,open}=fixture();contexts.get('creator').retired=true;
  assert.equal(open({url:blob,source_context:'creator'}).cookie_url,blob);
  contexts.delete('creator');assert.throws(()=>open({url:blob,source_context:'creator'}),{name:'SecurityError'});
});

test('Written Blob requests keep their virtual HTTP source without giving opaque documents an HTTP origin',()=>{
  const {open}=fixture(),opened=open({url:blob,source_context:'creator'});
  assert.equal(document_request_url({...opened,origin}),origin+'/');
  assert.equal(document_request_url({...opened,origin:'null'}),blob);
  assert.equal(document_request_url({url:new URL('about:blank'),origin,request_url:origin+'/creator'}),origin+'/creator');
  assert.equal(document_request_url({url:new URL('about:blank'),origin,request_url:blob}),origin+'/');
  assert.equal(document_request_url({url:new URL(origin+'/page'),origin}),origin+'/page');
});
