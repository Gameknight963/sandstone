import test from 'node:test';
import assert from 'node:assert/strict';
import {srcset_urls, rewrite_srcset} from '../src/frame/srcset.mjs';

test('Srcset tokenization preserves commas inside URLs and descriptor parentheses', () => {
  const input=' , small.png 1x, large.png 2x, data:image/svg+xml,%3Csvg%3E,%3C/svg%3E 3x, comma,in,url.png 4x, next.png,,, last.png';
  assert.deepEqual(srcset_urls(input).map(item=>item.url),['small.png','large.png','data:image/svg+xml,%3Csvg%3E,%3C/svg%3E','comma,in,url.png','next.png','last.png']);
  assert.deepEqual(srcset_urls('invalid.png future(a,b), valid.png 400w 200h').map(item=>item.url),['invalid.png','valid.png']);
});

test('Srcset rewriting retains all descriptors and authored formatting', async () => {
  const input='first.png  400w,\n second.png 800w, data:image/png;base64,AAAA 2x';
  const result=await rewrite_srcset(input,async url=>url.startsWith('data:')?url:'blob:'+url);
  assert.equal(result,'blob:first.png  400w,\n blob:second.png 800w, data:image/png;base64,AAAA 2x');
  assert.deepEqual(srcset_urls(' , , '),[]);
  assert.deepEqual(srcset_urls('one.png,two.png').map(item=>item.url),['one.png,two.png']);
});
