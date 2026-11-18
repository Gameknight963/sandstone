import test from 'node:test';
import assert from 'node:assert/strict';
import {create_url_constructor} from '../src/frame/url.mjs';

const NativeURL=globalThis.URL;
function install(t,mappings=new Map()){
  const methods=['parse','canParse'].map(key=>[key,Object.getOwnPropertyDescriptor(NativeURL,key)]);
  const constructor=Object.getOwnPropertyDescriptor(NativeURL.prototype,'constructor');
  t.after(()=>{for(const [key,descriptor] of methods)if(descriptor)Object.defineProperty(NativeURL,key,descriptor);else delete NativeURL[key];Object.defineProperty(NativeURL.prototype,'constructor',constructor)});
  return create_url_constructor(NativeURL,value=>mappings.get(value)??value);
}

test('URL conversion uses native string hints once and retains constructor argument order',t=>{
  const URL=install(t),trace=[];
  const input=(name,value)=>({[Symbol.toPrimitive](hint){trace.push(name+':'+hint);return value}});
  function Target(){}
  const target=new Proxy(Target,{get(object,key,receiver){if(key==='prototype')trace.push('prototype');return Reflect.get(object,key,receiver)}});
  const value=Reflect.construct(URL,[input('url','../item'),input('base','https://site.test/base/'),input('ignored','unused')],target);
  assert.equal(NativeURL.prototype.toString.call(value),'https://site.test/item');
  assert.equal(Object.getPrototypeOf(value),Target.prototype);
  assert.deepEqual(trace,['url:string','base:string','prototype']);
  assert.throws(()=>new URL(),TypeError);assert.throws(()=>URL('https://site.test/'),TypeError);
  assert.throws(()=>new URL(Symbol('url')),TypeError);
  const error=new RangeError('conversion');trace.length=0;
  assert.throws(()=>new URL({toString(){throw error}},input('base','https://site.test/')),value=>value===error);
  assert.deepEqual(trace,[]);
});

test('URL inputs honor authored string conversion and ordinary relative path names',t=>{
  const URL=install(t),value=new URL('https://old.test/');let strings=0;
  value.toString=()=>{strings++;return 'https://new.test/'};
  assert.equal(new URL(value).href,'https://new.test/');assert.equal(strings,1);
  assert.equal(new URL({get href(){throw new Error('href accessed')},toString(){return 'https://site.test/'}}).href,'https://site.test/');
  for(const path of ['constructor','toString','__proto__','hasOwnProperty'])assert.equal(new URL(path,'https://site.test/base/').href,'https://site.test/base/'+path);
  assert.equal(URL.name,NativeURL.name);assert.equal(URL.length,NativeURL.length);
  assert.equal(URL.prototype,NativeURL.prototype);assert.equal(URL.prototype.constructor,URL);
  class Derived extends URL{}
  const derived=new Derived('/path','https://site.test/');
  assert.ok(derived instanceof URL);assert.ok(derived instanceof Derived);assert.equal(derived.constructor,Derived);
});

test('URL constructors and static parsers relocate resource and base URLs without changing native instance identity',t=>{
  const resource='blob:null/resource',base='blob:null/base';
  const URL=install(t,new Map([[resource,'https://site.test/assets/chunk.js'],[base,'https://site.test/assets/']]));
  assert.equal(new URL(resource).href,'https://site.test/assets/chunk.js');assert.equal(new URL('next.js',base).href,'https://site.test/assets/next.js');
  for(const method of ['parse','canParse'])if(typeof URL[method]==='function'){
    const descriptor=Object.getOwnPropertyDescriptor(URL,method),parse=URL[method];
    assert.equal(descriptor.value,parse);assert.equal(parse.name,method);
    const result=Reflect.apply(parse,null,['next.js',base]);
    if(method==='parse'){
      assert.equal(result.href,'https://site.test/assets/next.js');assert.ok(result instanceof URL);assert.equal(result.constructor,URL);assert.equal(Object.getPrototypeOf(result),URL.prototype);
      assert.equal(parse(resource).href,'https://site.test/assets/chunk.js');
      class Derived extends URL{}assert.equal(Derived.parse(resource).constructor,URL);assert.equal(Derived.parse(resource) instanceof Derived,false);
    }else assert.equal(result,true);
    assert.equal(parse('http://['),method==='parse'?null:false);
    assert.throws(()=>parse(Symbol('url')),TypeError);assert.throws(()=>parse(),TypeError);
    const trace=[];parse({toString(){trace.push('url');return 'http://['}},{toString(){trace.push('base');return 'https://site.test/'}});assert.deepEqual(trace,['url','base']);
    const replacement=()=> 'patched';URL[method]=replacement;assert.equal(URL[method](), 'patched');Object.defineProperty(URL,method,descriptor);
  }
});

test('Native URL search parameters and object URL methods retain their identity and behavior',async t=>{
  const URL=install(t),value=new URL('https://site.test/?a=1'),params=value.searchParams;
  params.append('a','2');assert.equal(value.search,'?a=1&a=2');value.search='?b=3';assert.equal(value.searchParams,params);assert.deepEqual([...params],[['b','3']]);
  const url=URL.createObjectURL(new Blob(['payload']));
  try{assert.equal(new URL(url).href,url);assert.equal(await (await fetch(url)).text(),'payload')}finally{URL.revokeObjectURL(url)}
  await assert.rejects(fetch(url),TypeError);
});
