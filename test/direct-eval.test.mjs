import test from 'node:test';
import assert from 'node:assert/strict';
import {createContext,runInContext} from 'node:vm';
import {create_direct_eval} from '../src/frame/direct_eval.mjs';
import {rewrite_source} from '../src/frame/rewrite/javascript.mjs';
import {directEvalCases} from './direct-eval-cases.mjs';
import {create_with_scope} from '../src/frame/with_scope.mjs';

const globals=['eval','location','fetch','window','globalThis','Object','Promise'];
function evaluate(source,proxy){
  const realm=createContext({location:{href:'https://direct-eval.test/'},fetch:()=> 'native fetch'});
  const native=runInContext('globalThis',realm);realm.window=native;
  if(!proxy)return runInContext(source,realm);
  realm.location={href:'file:///physical.html'};realm.fetch=()=> 'physical fetch';
  const overrides=new Map([['location',{href:'https://direct-eval.test/'}],['fetch',()=> 'native fetch']]),live=new Set();
  const rewrite=(source,options={})=>rewrite_source(source,globals,{contextName:'__runtime__',globalName:'__runtime__.__globals__',thisName:'__runtime__.__get_this__',withContext:'(function(){return this})().__runtime__',directEval:true,...options});
  const virtual=source=>typeof source==='string'?runInContext(rewrite(source,{evalMode:true}),realm):source;
  let currentEval=virtual,view;
  view=new Proxy({},{
    get(_,name){if(name==='globalThis'||name==='window')return view;if(name==='eval')return currentEval;return live.has(name)?native[name]:overrides.has(name)?overrides.get(name):native[name];},
    set(_,name,value){if(name==='eval')currentEval=value;else if(live.has(name))native[name]=value;else overrides.set(name,value);return true;}
  });
  const helper=create_direct_eval({native:runInContext('eval',realm),virtual,rewrite:(source,context)=>rewrite(source,{evalMode:true,evalContext:context})});
  const entries=[];
  realm.__runtime__={
    __globals__:view,__get_this__:value=>value===native?view:value,
    __eval_scope__:()=>helper.scope(),__eval_declare__:(...args)=>helper.declare(...args),
    __eval_reference__:(...args)=>helper.reference(...args),__eval_select__:(...args)=>helper.select(...args),
    __eval_custom__:()=>helper.custom(),__eval_prepare__:(...args)=>helper.prepare(...args),
    __enter_with__:(value,parent)=>{const token=create_with_scope(value,parent,realm.__runtime__,view);entries.push(token);return token.object;},
    __take_with__:()=>entries.pop(),
    __declare_global_vars__:names=>names.forEach(name=>live.add(name)),
    __publish_global_function__:(name,value)=>{live.add(name);return value;},
    __publish_legacy_function__:(name,value)=>{view[name]=value;return value;}
  };
  return runInContext(rewrite(source),realm);
}

for(const {name,source} of directEvalCases)test('Direct eval: '+name,()=>{
  const wrapped='JSON.stringify((()=>{try{return {value:('+source+')}}catch(error){return {error:error.name}}})())';
  assert.equal(evaluate(wrapped,true),evaluate(wrapped,false));
});
