import test from 'node:test';
import assert from 'node:assert/strict';
import {window_features} from '../src/window_features.mjs';

test('Window features retain native boolean values, duplicate precedence and noreferrer implication',()=>{
  for(const [source,noopener,noreferrer] of [
    ['',false,false],['width=320,height=240',false,false],['noopener',true,false],['noopener=0',false,false],
    ['noopener=false',false,false],['noopener=true',true,false],['noopener=yes',true,false],['noopener=2',true,false],
    ['noopener=-1',true,false],['noopener=foo',false,false],['noopener = yes',true,false],['noopener=1,noopener=0',false,false],
    ['noreferrer',true,true],['noreferrer=0',false,false],['noreferrer=false',false,false],['NOOPENER = 0, NOREFERRER = TRUE',true,true],
    ['foo=noopener,bar=noreferrer',false,false],['=,noopener=0',false,false]
  ])assert.deepEqual(window_features(source),{noopener,noreferrer},source);
});
