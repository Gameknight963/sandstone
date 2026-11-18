import test from 'node:test';
import assert from 'node:assert/strict';
import {Script,createContext,constants} from 'node:vm';
import {rewrite_source} from '../src/frame/rewrite/javascript.mjs';
import {create_global_bindings} from '../src/frame/global_bindings.mjs';
import {create_obj_proxy,bind_native_property} from '../src/frame/global_functions.mjs';
import {create_with_scope} from '../src/frame/with_scope.mjs';

const names=['fetch','URL','window','globalThis','eval'];
function run(example,rewritten){
  const realm=createContext(constants.DONT_CONTEXTIFY);realm.fetch=()=>rewritten?'physical':'initial';realm.URL=function URL(){};
  const raw=new Script('globalThis').runInContext(realm),nativeEval=new Script('eval').runInContext(realm);
  const overlay={fetch:()=> 'initial'},context=create_obj_proxy(overlay,names,realm),bindings=create_global_bindings(context),entries=[];
  realm.window=raw;realm.__ctx__=context;realm.__get_this__=value=>value===raw?context:value;
  overlay.window=context;overlay.globalThis=context;overlay.__globals__=bindings.globals;
  overlay.__declare_global_lexicals__=definitions=>bindings.declare(definitions);
  overlay.__publish_legacy_function__=(name,value)=>{if(!bindings.has(name))context[name]=value;return value};
  overlay.__publish_global_function__=(name,value)=>{Object.defineProperty(context,name,{...Object.getOwnPropertyDescriptor(realm,name),value});bind_native_property(context,name);return value};
  overlay.__enter_with__=(value,parent)=>{const token=create_with_scope(value,parent,context,bindings.globals);entries.push(token);return token.object};overlay.__take_with__=()=>entries.pop();
  const execute=(source,mode)=>{
    if(rewritten)source=rewrite_source(source,names,{module:mode==='module',evalMode:mode==='eval',globalName:'__ctx__.__globals__'});
    if(mode==='eval')return Reflect.apply(nativeEval,undefined,[source]);
    if(mode==='module')source='(function(){"use strict";'+source+'})()';
    return new Script(source).runInContext(realm);
  };
  overlay.eval=source=>typeof source==='string'?execute(source,'eval'):source;
  execute('window.fetch=()=>"initial";window.trace=[];');
  for(const item of example.scripts){try{execute(typeof item==='string'?item:item.source,item.mode)}catch(error){if(!example.allowError)throw error;realm.trace.push(error.name)}}
  const view=rewritten?context:realm;return JSON.parse(JSON.stringify({result:view.result??null,trace:view.trace}));
}
const cases=[
  {name:'mutable cell shared between scripts',scripts:['let fetch=()=>1;','window.result=[fetch(),window.fetch()];fetch=()=>2;window.result.push(fetch(),fetch.name);']},
  {name:'const writes reject',scripts:['const fetch=()=>1;','try{fetch=()=>2}catch(error){trace.push(error.name)}window.result=[fetch(),window.fetch()];']},
  {name:'mutable class declaration',scripts:['class URL{static value(){return 1}}','window.result=[URL.value(),URL===window.URL];URL=()=>2;window.result.push(URL(),URL.name);']},
  {name:'destructured defaults',scripts:['let {fetch=()=>1,...URL}={value:42};','window.result=[fetch(),fetch.name,URL.value];']},
  {name:'earlier closure observes later lexical declaration',scripts:['window.read=()=>fetch();','let fetch=()=>1;','window.result=[read(),window.fetch()];']},
  {name:'TDZ through earlier closure',scripts:['window.read=()=>fetch();window.type=()=>typeof fetch;','try{read()}catch(error){trace.push(error.name)}try{type()}catch(error){trace.push(error.name)}let fetch=()=>1;window.result=read();']},
  {name:'failed declaration retains TDZ',allowError:true,scripts:['let fetch=(()=>{throw new Error("initialization")})();','try{window.result=typeof fetch}catch(error){window.result=error.name}']},
  {name:'window writes do not replace lexical cells',scripts:['let fetch=()=>1;','window.fetch=()=>2;window.result=[fetch(),window.fetch()];']},
  {name:'lexical deletion is rejected',scripts:['let fetch=()=>1;','window.result=[delete fetch,fetch()];delete window.fetch;window.result.push(fetch(),typeof window.fetch);']},
  {name:'block declarations stay local',scripts:['{let fetch=()=>1;trace.push(fetch())}','window.result=[fetch(),window.fetch()];']},
  {name:'for declarations stay local',scripts:['for(let fetch of [()=>1])trace.push(fetch());','window.result=[fetch(),window.fetch()];']},
  {name:'eval declarations stay local',scripts:[{source:'let fetch=()=>1;trace.push(fetch());',mode:'eval'},'window.result=[fetch(),window.fetch()];']},
  {name:'strict eval declarations stay local',scripts:[{source:'"use strict";let fetch=()=>1;trace.push(fetch());',mode:'eval'},'window.result=[fetch(),window.fetch()];']},
  {name:'eval reads and writes existing global cells',scripts:['let fetch=()=>1;','window.result=[window.eval("fetch()"),window.eval("fetch=()=>2;fetch()"),fetch(),window.fetch()];']},
  {name:'var conflicts do not replace cells',scripts:['let fetch=()=>1;','try{window.eval("var fetch=()=>2")}catch(error){trace.push(error.name)}window.result=[fetch(),window.fetch()];']},
  {name:'module reads global lexical binding',scripts:['let fetch=()=>1;',{source:'window.result=[fetch(),window.fetch()];fetch=()=>2;window.result.push(fetch());',mode:'module'}]},
  {name:'module local declarations do not escape',scripts:[{source:'let fetch=()=>1;trace.push(fetch());',mode:'module'},'window.result=[fetch(),window.fetch()];']},
  {name:'globalThis lexical binding remains separate',scripts:['const globalThis=()=>1;','window.result=[globalThis(),typeof window.globalThis,globalThis===window.globalThis];']},
  {name:'bare calls retain undefined receivers',scripts:['let fetch=function(){"use strict";return this===undefined};','window.result=[fetch(),fetch?.(),fetch``];']},
  {name:'with fallback sees lexical cells',scripts:['let fetch=()=>1;','with({})trace.push(fetch());with({fetch:()=>2})trace.push(fetch());with(window)trace.push(fetch());window.result=fetch();']},
  {name:'with unscopables falls back to lexical cell',scripts:['let fetch=()=>1;','with({fetch:()=>2,[Symbol.unscopables]:{fetch:true}})window.result=fetch();']},
  {name:'Annex B declarations cannot replace prior lexical cells',allowError:true,scripts:['let fetch=()=>1;','{function fetch(){return 2}trace.push(fetch())}','window.result=[fetch(),window.fetch()];']},
  {name:'Annex B declarations preserve cells in with',allowError:true,scripts:['let fetch=()=>1;','with({}){{function fetch(){return 2}trace.push(fetch())}}','window.result=[fetch(),window.fetch()];']},
  {name:'duplicate declaration leaves previous cell',allowError:true,scripts:['let fetch=()=>1;','let fetch=()=>2;','window.result=[fetch(),window.fetch()];']},
  {name:'assignment inference preserves ASI',scripts:['let fetch=()=>1;','fetch=()=>2','window.result=[fetch(),fetch.name];']},
  {name:'with statement ASI preserves else branch',scripts:['let fetch=()=>1;','if(false)with({fetch:()=>2})trace.push(fetch())\nelse trace.push("else")','window.result=[fetch(),trace];']},
  {name:'with statement ASI preserves true branch',scripts:['let fetch=()=>1;','if(true)with({fetch:()=>2})trace.push(fetch())\nelse trace.push("else")','window.result=[fetch(),trace];']}
];
for(const example of cases)test('Global lexical cells match native behavior: '+example.name,()=>assert.deepEqual(run(example,true),run(example,false)));
