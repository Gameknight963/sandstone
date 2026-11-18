import test from 'node:test';
import assert from 'node:assert/strict';
import {Script,createContext,constants} from 'node:vm';
import {rewrite_source} from '../src/frame/rewrite/javascript.mjs';
import {create_obj_proxy,bind_native_property,bind_declared_property} from '../src/frame/global_functions.mjs';
import {create_with_scope} from '../src/frame/with_scope.mjs';

const globals=['fetch','Worker','globalThis','window','eval'];
function run(example,rewritten){
  const realm=createContext(constants.DONT_CONTEXTIFY),overlay={fetch:()=> 'initial'};
  realm.fetch=()=>rewritten?'physical':'initial';realm.Worker=function Worker(){};
  const virtual=create_obj_proxy(overlay,globals,realm);
  realm.__ctx__=virtual;overlay.globalThis=virtual;overlay.window=virtual;
  const raw=new Script('globalThis').runInContext(realm),nativeEval=new Script('eval').runInContext(realm);
  realm.window=raw;realm.__get_this__=value=>value===raw?virtual:value;
  const entries=[];overlay.__enter_with__=(value,parent)=>{const token=create_with_scope(value,parent,virtual);entries.push(token);return token.object};overlay.__take_with__=()=>entries.pop();
  overlay.__declare_global_vars__=names=>{for(const name of names)bind_declared_property(virtual,name)};
  overlay.__publish_global_function__=(name,value)=>{Object.defineProperty(virtual,name,{...Object.getOwnPropertyDescriptor(realm,name),value});bind_native_property(virtual,name);return value};
  const execute=(source,mode)=>{
    if(rewritten)source=rewrite_source(source,globals,{module:mode==='module',evalMode:mode==='eval'});
    if(mode==='eval')return Reflect.apply(nativeEval,undefined,[source]);
    if(mode==='module')source='(function(){"use strict";'+source+'})()';
    return new Script(source).runInContext(realm);
  };
  overlay.eval=source=>typeof source==='string'?execute(source,'eval'):source;
  execute('globalThis.trace=[];globalThis.fetch=()=>"initial";');
  if(example.setup)execute(example.setup);
  let completion;for(const source of example.sources||[example.source])completion=execute(source,example.mode);
  const view=rewritten?virtual:realm;
  return JSON.parse(JSON.stringify({result:view.result??null,trace:view.trace,completion:completion??null}));
}
const cases=[
  {name:'uninitialized aliases',source:'var fetch;globalThis.result=[fetch(),fetch===window.fetch];'},
  {name:'simple initializer and inference',source:'var fetch=function(){};globalThis.result=[fetch.name,fetch===window.fetch];'},
  {name:'strict initializer',source:'"use strict";var fetch=()=>42;globalThis.result=[fetch(),window.fetch(),fetch.name];'},
  {name:'parenthesized sequence',source:'var fetch=(trace.push(1),()=>42),last=(trace.push(2),7);globalThis.result=[fetch(),window.fetch(),fetch.name,last];'},
  {name:'parenthesized anonymous function',source:'var fetch=(((function(){})));globalThis.result=[fetch.name,fetch===window.fetch];'},
  {name:'mixed binding pattern',source:'var {nested:[fetch=()=>42,other=3]}={nested:[]};globalThis.result=[fetch(),fetch.name,other,fetch===window.fetch];'},
  {name:'shorthand pattern default',source:'var {fetch=()=>42}={};globalThis.result=[fetch(),fetch.name,fetch===window.fetch];'},
  {name:'computed pattern key',source:'var {[(trace.push("key"),"fn")]:fetch=(trace.push("default"),()=>42)}={};globalThis.result=[fetch(),fetch.name,fetch===window.fetch];'},
  {name:'object rest',source:'var {ignore,...Worker}={ignore:1,value:2};globalThis.result=[ignore,Worker,Worker===window.Worker];'},
  {name:'array rest',source:'var [other,...fetch]=[1,2,3];globalThis.result=[other,fetch,fetch===window.fetch];'},
  {name:'unexecuted initializer',source:'if(false){var fetch=()=>42}globalThis.result=[fetch(),fetch===window.fetch];'},
  {name:'prior closure',source:'const read=()=>fetch();var fetch=()=>42;globalThis.result=[read(),window.fetch()];'},
  {name:'subsequent script',sources:['var fetch=()=>42;','globalThis.result=[fetch(),window.fetch(),fetch.name];']},
  {name:'window writes after initialization',source:'var fetch=()=>1;window.fetch=()=>2;globalThis.result=[fetch(),window.fetch()];'},
  {name:'global function and initializer',source:'var fetch=()=>2;function fetch(){return 1}globalThis.result=[fetch(),window.fetch()];'},
  {name:'local variable exclusion',source:'function read(){var fetch=()=>2;return fetch()}globalThis.result=[read(),fetch(),window.fetch()];'},
  {name:'catch binding exclusion',source:'try{throw 1}catch(fetch){var fetch=2;trace.push(fetch)}globalThis.result=[fetch(),window.fetch()];'},
  {name:'standard for initializer',source:'for(var fetch=()=>2,n=0;n<2;n++)trace.push(fetch());globalThis.result=[fetch(),fetch.name,n,fetch===window.fetch];'},
  {name:'for of patterns',source:'for(var [fetch,other] of [[()=>1,3],[()=>2,4]])trace.push(fetch());globalThis.result=[fetch(),other,fetch===window.fetch];'},
  {name:'for in iteration',source:'for(var fetch in {one:1,two:2})trace.push(fetch);globalThis.result=[fetch,window.fetch];'},
  {name:'legacy for in initializer',source:'const values={one:1};for(var fetch=(trace.push("init"),()=>2) in (trace.push("right"),values))trace.push(fetch);globalThis.result=[fetch,window.fetch];'},
  {name:'legacy for in identifier right side',source:'const values={one:1};for(var fetch=()=>2 in values)trace.push(fetch);globalThis.result=[fetch,window.fetch];'},
  {name:'legacy for in null',source:'for(var fetch=()=>2 in null)trace.push("body");globalThis.result=[fetch(),fetch.name,fetch===window.fetch];'},
  {name:'conditional legacy initializer',source:'if(false)for(var fetch=()=>2 in {}){}globalThis.result=[fetch(),window.fetch()];'},
  {name:'eval completion',mode:'eval',source:'"prior";var fetch=()=>2;'},
  {name:'strict eval exclusion',mode:'eval',source:'"use strict";var fetch=()=>2;globalThis.result=[fetch(),window.fetch()];'},
  {name:'module exclusion',mode:'module',source:'var fetch=()=>2;globalThis.result=[fetch(),window.fetch()];'},
  {name:'getter is not sampled by declaration',setup:'Object.defineProperty(window,"fetch",{configurable:true,get(){trace.push("get");return ()=>3}});',source:'var fetch;globalThis.result=[fetch(),window.fetch()];'},
  {name:'setter initialization order',setup:'Object.defineProperty(window,"fetch",{configurable:true,get(){trace.push("get");return ()=>3},set(value){trace.push(["set",value.name])}});',source:'var fetch=()=>2;globalThis.result=[fetch(),window.fetch()];'},
  {name:'destructuring closes iterator on failure',setup:'Object.defineProperty(window,"fetch",{configurable:true,set(){throw new Error("setter")}});',source:'const items={[Symbol.iterator](){return {next(){trace.push("next");return {value:1}},return(){trace.push("close");return {done:true}}}}};try{var [fetch]=items}catch(error){globalThis.result=error.message}'},
  {name:'strict rejected write',setup:'Object.defineProperty(window,"fetch",{value:()=>1,writable:false,configurable:true});',source:'"use strict";try{var fetch=()=>2}catch(error){globalThis.result=error.name}'},
  {name:'with object binding',source:'var fetch;with({fetch:()=>2})trace.push(fetch());globalThis.result=[fetch(),window.fetch()];'},
  {name:'with fallback binding',source:'var fetch=()=>2;with({})trace.push(fetch());globalThis.result=[fetch(),window.fetch()];'},
  {name:'with initializer',source:'const obj={fetch:()=>3};with(obj){var fetch=()=>2;trace.push(fetch(),fetch===obj.fetch)}globalThis.result=[fetch(),window.fetch(),obj.fetch()];'},
  {name:'with receiver and identity',source:'var fetch;const obj={fetch(){return this===obj}};with(obj){trace.push(fetch(),fetch===obj.fetch,fetch?.(),fetch``)}globalThis.result=[fetch(),window.fetch()];'},
  {name:'nested with scopes',source:'var fetch=()=>1;const outer={fetch:()=>2};with(outer){with({})trace.push(fetch());with({fetch:()=>3})trace.push(fetch())}globalThis.result=fetch();'},
  {name:'with unscopables',source:'var fetch=()=>1;with({fetch:()=>2,[Symbol.unscopables]:{fetch:true}})trace.push(fetch());globalThis.result=fetch();'},
  {name:'with sequence object',source:'var fetch=()=>1;const obj={fetch:()=>2};with((trace.push("object"),obj))trace.push(fetch());globalThis.result=fetch();'},
  {name:'with retained closures',source:'var fetch=()=>1;const obj={fetch:()=>2};let read;with(obj){read=()=>fetch()}obj.fetch=()=>3;globalThis.result=[read(),fetch()];'},
  {name:'with function before arguments',source:'var fetch=()=>1;const obj={fetch(value){return [value,this===obj]}};with(obj)trace.push(fetch((delete obj.fetch,3)));globalThis.result=fetch();'},
  {name:'with proxy lookup order',source:'var fetch=()=>1;const obj=new Proxy({fetch:()=>2},{has(target,key){if(key==="fetch")trace.push("has");return Reflect.has(target,key)},get(target,key,receiver){if(key===Symbol.unscopables)trace.push("unscopables");if(key==="fetch")trace.push("get");return Reflect.get(target,key,receiver)},set(target,key,value,receiver){if(key==="fetch")trace.push("set");return Reflect.set(target,key,value,receiver)}});with(obj){fetch();fetch=()=>3;fetch++;}globalThis.result=fetch();'},
  {name:'with strict retained closure',source:'var fetch=()=>1;const obj={fetch:()=>2};let read;with(obj){read=function(){"use strict";return [fetch(),this===undefined]}}globalThis.result=read();'},
  {name:'with local shadow',source:'var fetch=()=>1;globalThis.result=(function(fetch){with({})return fetch()})(()=>2);'},
  {name:'with legacy loop',source:'var fetch=()=>1;const obj={fetch:()=>2};with(obj){for(var fetch=()=>3 in null){}trace.push(fetch())}globalThis.result=[fetch(),obj.fetch()];'},
  {name:'subsequent assignment inference',source:'var fetch;fetch=()=>1;trace.push(fetch.name);fetch=null;fetch||=function(){};globalThis.result=fetch.name;'},
  {name:'destructuring assignment inference',source:'var fetch;({fetch=()=>1}={});globalThis.result=[fetch.name,fetch===window.fetch];'},
  {name:'with write resolves after RHS',source:'var fetch=()=>1;const obj={fetch:()=>2};with(obj){fetch=(delete obj.fetch,()=>3)}globalThis.result=[fetch(),typeof obj.fetch];'},
  {name:'with getter changes binding before compound write',source:'var fetch=1;const obj={get fetch(){delete this.fetch;return 2}};with(obj){fetch++}globalThis.result=[fetch,typeof obj.fetch];'},
  {name:'with block function',source:'var fetch=()=>1;with({}){{function fetch(){return 2}}trace.push(fetch())}globalThis.result=[fetch(),window.fetch()];'},
  {name:'with hostile helper names',source:'var fetch=()=>1;const obj={fetch:()=>2,__ctx__:null,__get_this__:null};with(obj){var fetch=function(){return this===obj};trace.push(fetch())}globalThis.result=[fetch(),obj.fetch()];'},
  {name:'with Window receiver',source:'var fetch=function(){"use strict";return this===window};with(window){globalThis.result=[fetch(),fetch?.(),fetch``]}'},
  {name:'with global fallback receiver',source:'var fetch=function(){"use strict";return this===undefined};with({}){globalThis.result=[fetch(),fetch?.(),fetch``]}'}
];
for(const example of cases)test('Global var bindings match native behavior: '+example.name,()=>assert.deepEqual(run(example,true),run(example,false)));
