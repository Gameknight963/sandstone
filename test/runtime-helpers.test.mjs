import test from 'node:test';
import assert from 'node:assert/strict';
import {create_runtime_helpers} from '../src/frame/runtime_helpers.mjs';
import {create_with_scope} from '../src/frame/with_scope.mjs';

test('Runtime helpers retain their original methods while site properties change',()=>{
  class Context {
    constructor(){this.value=7;}
    __read__(){return this.value;}
    get __globals__(){return this.value;}
  }
  const context=new Context(),helpers=create_runtime_helpers(context,['__read__','__globals__']);
  Object.defineProperty(context,'__read__',{value:()=>9});
  Object.defineProperty(Context.prototype,'__read__',{value:()=>11});
  assert.equal(helpers.__read__(),7);
  context.value=13;
  assert.equal(helpers.__read__(),13);assert.equal(helpers.__globals__,13);
  assert.equal(Object.getPrototypeOf(helpers),null);assert.equal(Object.isFrozen(helpers),true);
  assert.throws(()=>{helpers.__read__=()=>17;},TypeError);
  assert.equal(Reflect.defineProperty(helpers,'__read__',{value:()=>19}),false);
});

test('With-state registration and lookup use captured WeakMap methods',()=>{
  const nativeGet=WeakMap.prototype.get,nativeSet=WeakMap.prototype.set;
  let calls=0,result;
  try{
    WeakMap.prototype.get=function(...args){calls++;return Reflect.apply(nativeGet,this,args);};
    WeakMap.prototype.set=function(...args){calls++;return Reflect.apply(nativeSet,this,args);};
    const parent=create_with_scope({value:7},null,{},{}),child=create_with_scope({},parent,{},{});
    result=child.reference('value').value;
  }finally{WeakMap.prototype.get=nativeGet;WeakMap.prototype.set=nativeSet;}
  assert.equal(result,7);assert.equal(calls,0);
});
