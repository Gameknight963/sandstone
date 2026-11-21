import test from 'node:test';
import assert from 'node:assert/strict';
import {javascript_url_source} from '../src/javascript_url.mjs';

test('JavaScript URL sources decode once as UTF-8 with native legacy byte fallback',()=>{
  for(const [url,source] of [
    ['javascript:globalThis.value%20=%20%22caf%C3%A9%22;void%200','globalThis.value = "café";void 0'],
    ['javascript:globalThis.value="raw é + %2B %2520 %";void 0','globalThis.value="raw é + + %20 %";void 0'],
    ['javascript:void 0?"%3F":"%23"#%23','void 0?"?":"#"##'],
    ['javascript:"%f0%9f%8c%8d"','"🌍"'],
    ['javascript:%EF%BB%BFvoid%200','void 0'],
    ['JAVASCRIPT:/*line*/%0D%0Avoid%200','/*line*/\r\nvoid 0'],
    ['javascript:"%FF%E9%00%2G%2"','"ÿé\0%2G%2"'],
    ['javascript:"%E2%28%A1"','"â(¡"'],
    ['javascript:"caf%C3%A9 é %FF"','"cafÃ© Ã© ÿ"'],
    ['javascript:"%80%9F"','"\u0080\u009f"']
  ])assert.equal(javascript_url_source(new URL(url).href),source,url);
});
