import test from 'node:test';
import assert from 'node:assert/strict';
import {rewrite_dynamic_function} from '../src/frame/rewrite/javascript.mjs';
import {create_global_scope} from '../src/frame/global_functions.mjs';

function compile(Constructor,args,context){
  const native=Reflect.apply(Constructor,undefined,args),source=Function.prototype.toString.call(native);
  const output=rewrite_dynamic_function(source,['location','globalThis','fetch']);
  const body=output.needsScope?'with('+output.scopeName+'){return '+output.source+'}':'return '+output.source;
  return Function(output.contextName,output.thisName,output.scopeName,body)(context,value=>value===globalThis?context:value,create_global_scope(context,['location','globalThis','fetch']));
}

test('Dynamic template scopes retain local methods, assignments, unscopables and direct eval bindings',()=>{
  const context={location:{href:'https://virtual.test/'}};context.globalThis=context;
  const locals={location:'local',value:7,fetch(){return this.value;}};
  assert.deepEqual(compile(Function,['data','with(data){return [location,fetch()]}'],context)(locals),['local',7]);
  assert.equal(compile(Function,['data','with(data){location="changed";return location}'],context)(locals),'changed');
  assert.equal(locals.location,'changed');
  locals[Symbol.unscopables]={location:true};
  assert.equal(compile(Function,['data','with(data){return location.href}'],context)(locals),context.location.href);
  assert.equal(compile(Function,['value','return eval("value")'],context)(7),7);
  assert.equal(compile(Function,['return eval("location.href")'],context)(),context.location.href);
  assert.equal(compile(Function,['eval("var location = 7");return location'],context)(),7);
});
test('Dynamic function rewriting keeps parameters and fresh helper bindings separate from virtual globals',()=>{
  const context={location:{href:'https://virtual.test/'}};context.globalThis=context;
  assert.equal(compile(Function,['value=location.href','return value'],context)(),context.location.href);
  assert.equal(compile(Function,['fetch','return fetch'],context)('local'),'local');
  assert.deepEqual(compile(Function,['__ctx__','return [__ctx__,location.href]'],context)('local'),['local',context.location.href]);
  assert.deepEqual(compile(Function,['\\u005f_sandstone_dynamic_context__','return [arguments[0],location.href]'],context)('local'),['local',context.location.href]);
  assert.equal(compile(Function,['return typeof __sandstone_dynamic_context__'],context)(),'undefined');
  assert.equal(compile(Function,['return typeof anonymous'],context)(),'undefined');
  assert.equal(compile(Function,['return this===globalThis'],context)(),true);
});
test('Dynamic async and generator sources preserve native function kinds and parameter scope',async()=>{
  const context={location:{href:'https://virtual.test/'}};context.globalThis=context;
  const Async=Object.getPrototypeOf(async function(){}).constructor,Generator=Object.getPrototypeOf(function*(){}).constructor,AsyncGenerator=Object.getPrototypeOf(async function*(){}).constructor;
  assert.equal(await compile(Async,['value=location.href','return value'],context)(),context.location.href);
  for(const Constructor of [Generator,AsyncGenerator]){
    const iterator=compile(Constructor,['value=location.href','yield value;return this===globalThis'],context)();
    assert.deepEqual(await iterator.next(),{done:false,value:context.location.href});
    assert.deepEqual(await iterator.next(),{done:true,value:true});
  }
});
