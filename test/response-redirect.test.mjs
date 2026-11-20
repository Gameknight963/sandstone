import test from 'node:test';
import assert from 'node:assert/strict';
import {create_response_redirect} from '../src/frame/response.mjs';

test('Response.redirect resolves relative URLs dynamically and retains native responses and header guards',()=>{
  let base='https://site.test/app/page';const redirect=create_response_redirect(()=>base);
  for(const [url,expected] of [['../login','https://site.test/login'],['?next=1#done','https://site.test/app/page?next=1#done'],['https://other.test/path','https://other.test/path'],['data:text/plain,hello','data:text/plain,hello']]){
    const response=redirect(url);assert.equal(response.status,302);assert.equal(response.type,'default');assert.equal(response.url,'');assert.equal(response.body,null);assert.equal(response.headers.get('location'),expected);assert.throws(()=>response.headers.set('x','y'),TypeError);
    assert.equal(response.clone().headers.get('location'),expected);
  }
  base='https://site.test/changed/base/';assert.equal(redirect('next',307).headers.get('location'),'https://site.test/changed/base/next');
  assert.equal(redirect.name,Response.redirect.name);assert.equal(redirect.length,Response.redirect.length);assert.throws(()=>new redirect('next'),TypeError);
});

test('Redirect conversion preserves Web IDL numeric conversion, ordering, defaults and native errors',()=>{
  const log=[];let base='https://site.test/old/';const redirect=create_response_redirect(()=>{log.push('base');return base;});
  const input={toString(){log.push('url');return 'next';}},status={valueOf(){log.push('status');base='https://site.test/new/';return 65536+303;}};
  assert.equal(redirect(input,status).headers.get('location'),'https://site.test/new/next');assert.deepEqual(log,['url','status','base']);
  for(const value of [undefined,301,302,303,307,308,65536+302,302.9]){
    const actual=redirect('/next',value),expected=Response.redirect('https://site.test/next',value);assert.equal(actual.status,expected.status);
  }
  assert.equal(redirect('/next',-65536+307).status,307);
  for(const value of [null,NaN,Infinity,0,200,304,309,-1,Symbol('status')])assert.throws(()=>redirect('/next',value),error=>{try{Response.redirect('https://site.test/next',value);}catch(native){return error.name===native.name;}return false;});
  assert.throws(()=>redirect('/next',1n),TypeError);
  for(const input of [Symbol('url'),{toString(){throw new Error('url coercion');}}]){let visited=false;assert.throws(()=>redirect(input,{valueOf(){visited=true;return 302;}}));assert.equal(visited,false);}
  let visited=false;assert.throws(()=>redirect('http://[',{valueOf(){visited=true;return 200;}}),TypeError);assert.equal(visited,true);
  assert.throws(()=>redirect(),TypeError);assert.equal(redirect(undefined).headers.get('location'),'https://site.test/new/undefined');
});

