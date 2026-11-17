import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve_base_href} from '../src/base_url.mjs';
test('Base URL selection rejects unsafe schemes and preserves a frozen URL on parse failure',()=>{
  const fallback='https://site.test/path/page#hash',previous='https://cdn.test/frozen/';
  assert.equal(resolve_base_href('./assets/',fallback),'https://site.test/path/assets/');
  assert.equal(resolve_base_href('data:text/plain,x',fallback,previous),fallback);
  assert.equal(resolve_base_href('javascript:void(0)',fallback,previous),fallback);
  assert.equal(resolve_base_href('http://[',fallback,previous),previous);
  assert.equal(resolve_base_href(null,fallback,previous),fallback);
});
