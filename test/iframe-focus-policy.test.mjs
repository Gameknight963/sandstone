import test from 'node:test';import assert from 'node:assert/strict';
import {iframe_focus_policy} from '../src/frame/iframe_focus_policy.mjs';
const feature='focus-without-user-activation',base={parent:'https://parent.test',document:'https://parent.test/child',source:'https://parent.test/child'};
const permits=(allow,options={})=>iframe_focus_policy(allow,{...base,...options}).split(';').find(value=>value.trim().startsWith(feature)).trim()===feature+' *';
test('Frame focus permissions resolve self, src, origin and opaque source grants against virtual origins',()=>{
  assert.equal(permits(null),true);assert.equal(permits(null,{document:'https://cross.test/child'}),false);
  assert.equal(permits(null,{document:'https://cross.test/child',defaultAll:true}),true);
  assert.equal(permits(null,{opaque:true,defaultAll:true}),false);
  assert.equal(permits(feature+" 'self'"),true);assert.equal(permits(feature+" 'self'",{document:'https://cross.test/child'}),false);
  assert.equal(permits(feature),true);assert.equal(permits(feature,{opaque:true}),true);
  assert.equal(permits(feature,{document:'https://redirect.test/final'}),false);
  assert.equal(permits(feature+' https://parent.test'),true);assert.equal(permits(feature+' https://parent.test',{opaque:true}),false);
  assert.equal(permits(feature+' *',{opaque:true}),true);assert.equal(permits(feature+" 'none'"),false);
  assert.equal(permits(feature+" 'self'",{opaque:true}),false);
});
test('Frame focus translation retains unrelated directives and uses the first declared feature policy',()=>{
  const allow='autoplay; fullscreen; '+feature+" 'none'; "+feature+' *';
  assert.equal(permits(allow),false);assert.deepEqual(iframe_focus_policy(allow,base).split(';').map(value=>value.trim()).filter(value=>!value.startsWith(feature)),['autoplay','fullscreen']);
});
