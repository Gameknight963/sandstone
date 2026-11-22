import test from 'node:test';
import assert from 'node:assert/strict';
import {search_destination} from '../src/search_redirect.mjs';

test('DuckDuckGo HTML results navigate to the encoded HTTP destination',()=>{
  const destination='https://en.wikipedia.org/wiki/Hello';
  const provided='https://duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FHello&rut=eaf45752ea38c5c00352fa0921b50cddf5c017cafd239bdf129a7be6edb1f665';
  assert.equal(search_destination(provided),destination);
  for(const host of ['duckduckgo.com','www.duckduckgo.com','html.duckduckgo.com','lite.duckduckgo.com']){
    const target='https://example.test/a%2Fb?q=hello%20world&next=%2520#section';
    assert.equal(search_destination('https://'+host+'/l/?uddg='+encodeURIComponent(target)),target);
  }
  assert.equal(search_destination('https://duckduckgo.com/l/?uddg='+encodeURIComponent('http://example.test/path')),'http://example.test/path');
});

test('Only recognized DuckDuckGo redirects with absolute HTTP destinations are unwrapped',()=>{
  for(const target of ['javascript:alert(1)','data:text/html,test','file:///tmp/test','blob:https://example.test/id','//example.test/path','/relative','https%3A%2F%2Fexample.test','http://[','']){
    const input='https://duckduckgo.com/l/?uddg='+encodeURIComponent(target);
    assert.equal(search_destination(input),input,target);
  }
  for(const input of [
    'https://example.test/l/?uddg=https://destination.test',
    'https://duckduckgo.com.example.test/l/?uddg=https://destination.test',
    'https://duckduckgo.com@evil.test/l/?uddg=https://destination.test',
    'https://duckduckgo.com:8443/l/?uddg=https://destination.test',
    'https://duckduckgo.com/search?uddg=https://destination.test',
    'https://duckduckgo.com/l/?other=https://destination.test',
    'not a URL'
  ])assert.equal(search_destination(input),input);
});
