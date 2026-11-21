import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {instrument_javascript_completion,create_javascript_completion} from '../src/frame/javascript_completion.mjs';

const cases=[
  '', '// final comment', '#! /usr/bin/env node\n', '"html"', '"use strict";', '"use strict";"html";var unused=1;',
  '"html";let unused=1;', '"html";if(false)"other";', 'if(true)"yes";else "no";',
  'let index=0;while(index++<3){"loop"+index;}', 'for(let index=0;index<3;index++){"loop"+index;}',
  'outer:for(let index=0;index<3;index++){"chosen";if(index===1)break outer;}',
  'let value="";do{value+="x";value;}while(value.length<2);',
  'switch(2){case 1:"one";break;case 2:"two";break;default:"other";}',
  'try{"try";}finally{"ignored";}', 'try{throw "failure";}catch(error){error+" caught";}finally{"ignored";}',
  'try{"try";}finally{throw "failure";}',
  'function run(){trace.push("function");"ignored";return "returned";}run();',
  '(()=>{trace.push("arrow");return "returned";})()',
  '"prior";class Example {static {"ignored";trace.push("class");} method(){return "method"}}',
  '(class {static {"ignored";trace.push("class");}});"after";',
  'with({value:"selected"}){value;}', 'with(new Proxy({},{has(){return true},get(){return "selected"}})){anything;}',
  'let value;({text:value}={text:"assignment"});value;', '1\n;2', 'true', 'null', 'void 0', '13n', 'symbol', 'object', 'boxed',
  '"use strict";missing=1;', 'throw "failure";', 'let duplicated;let duplicated;',
  '1;{}', '1;label:{}', '1;label:{break label;}', '1;label:{2;break label;}',
  '1;while(false){}', '1;for(;;)break;', '1;for(var i=0;i<0;i++){}',
  '1;for(var i in {}){}', '1;for(var i of []){}',
  '1;with({}){}', '1;try{}finally{}', '1;try{throw 2}catch(e){}',
  'outer:for(let i=0;i<2;i++){try{3;continue outer;}finally{4;}}',
  'outer:for(let i=0;i<2;i++){try{3;}finally{4;break outer;}}',
  'outer:while(true){try{try{3;}finally{4;}}finally{5;break outer;}}',
  'outer:inner:do{5;break outer;}while(true);',
  'if(true)while(false)1;else 2;', 'if(false)while(false)1;else 2;',
  'var i=9;for(var i;i<0;i++){}i;',
  'try{42}finally{73}', 'while(false)42', '1;label:function f(){}',
  '1;for /* ; */ (/* ; */ ;false;){}', '1;for // ;\n(;false;){}',
  '1,2', '(1,2)', '({value:3})', 'let a,b;(a=1,b=2)'
];
const bodies=['{}','5;','var unused;','if(false)8;','if(true)8;','try{}finally{9;}','try{8;}finally{}','throw "abrupt";'];
for(const body of bodies)for(const wrap of [
  body=>'1;{'+body+'}',body=>'1;if(true){'+body+'}',body=>'1;if(false){}else{'+body+'}',
  body=>'1;for(let i=0;i<2;i++){'+body+'}',body=>'1;let i=0;while(i++<2){'+body+'}',
  body=>'1;let i=0;do{'+body+'}while(i++<2);',body=>'1;label:{'+body+'}',
  body=>'1;try{'+body+'}finally{11;}',body=>'1;try{11;}finally{'+body+'}',
  body=>'1;try{throw "caught";}catch(error){'+body+'}',
  body=>'1;switch(0){case 0:'+body+';break;}',body=>'1;with({}){'+body+'}'
])cases.push(wrap(body));
function run(source,instrumented,fixtures){
  const trace=[],control=create_javascript_completion(),context=vm.createContext({...fixtures,trace,control});
  let value,error;
  try{value=vm.runInContext(instrumented?instrument_javascript_completion(source,'this.control'):source,context);if(instrumented)value=control.result().value;}catch(failure){error={type:typeof failure,name:failure?.name||failure};}
  return {value,error,trace,completed:control.result().completed,context};
}

test(`JavaScript completion instrumentation matches ${cases.length} native control-flow cases without wrapping lexical scopes`,()=>{
  const fixtures={symbol:Symbol('value'),object:{toString(){throw new Error('Completion must not coerce objects');}},boxed:new String('html')};
  for(const source of cases){
    const expected=run(source,false,fixtures),actual=run(source,true,fixtures);
    assert.deepEqual(actual.error,expected.error,source);assert.deepEqual(actual.trace,expected.trace,source);
    if(!expected.error){
      if(expected.value&&typeof expected.value==='object'&&!Object.values(fixtures).includes(expected.value))assert.equal(JSON.stringify(actual.value),JSON.stringify(expected.value),source);
      else assert.equal(actual.value,expected.value,source);
    }
    assert.equal(actual.completed,!expected.error,JSON.stringify(source));
  }
});

test('Completion instrumentation retains global declarations, strictness, directives and local function source',()=>{
  const source='"use strict";let shared=3;var publicValue=4;function read(){return shared+publicValue;}"html";';
  const native=run(source,false,{}),instrumented=run(source,true,{});
  assert.equal(vm.runInContext('shared++;read()',instrumented.context),vm.runInContext('shared++;read()',native.context));
  assert.equal(vm.runInContext('read.toString()',instrumented.context),vm.runInContext('read.toString()',native.context));
  assert.deepEqual(Object.getOwnPropertyDescriptor(instrumented.context,'publicValue'),Object.getOwnPropertyDescriptor(native.context,'publicValue'));
});
