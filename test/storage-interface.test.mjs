import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeStorage,install_storage_prototype} from '../src/frame/polyfill/storage.mjs';

test('Storage methods retain identity and validate receivers, required arguments and DOMString conversions',()=>{
  const storage=new FakeStorage();
  assert.equal(storage.getItem,storage.getItem);assert.equal(storage.constructor,FakeStorage);
  const get=storage.getItem;assert.throws(()=>get('key'),TypeError);
  for(const name of ['getItem','setItem','removeItem','clear','key'])assert.throws(()=>FakeStorage.prototype[name].call({}),TypeError);
  for(const call of [()=>storage.getItem(),()=>storage.setItem('key'),()=>storage.removeItem(),()=>storage.key(),()=>storage.getItem(Symbol()),()=>storage.setItem('key',Symbol()),()=>storage.key(1n)])assert.throws(call,TypeError);
  storage.setItem(undefined,undefined);assert.equal(storage.getItem('undefined'),'undefined');
  storage.setItem(1n,2n);assert.equal(storage.getItem('1'),'2');
});

test('Argument coercion completes before storage is read or document access is checked',()=>{
  let active=true,storage;
  storage=new FakeStorage([],()=>storage._replace_entries(storage._get_entries()),()=>{if(!active)throw new DOMException('Inactive','SecurityError');});
  storage.setItem('old','value');
  assert.equal(storage.getItem({toString(){storage.clear();storage.setItem('new','value');return 'new';}}),'value');
  assert.equal(storage.key({valueOf(){storage.clear();storage.setItem('coerced','value');return 0;}}),'coerced');
  active=false;
  assert.throws(()=>storage.getItem(),TypeError);assert.throws(()=>storage.getItem(Symbol()),TypeError);
  assert.throws(()=>storage.getItem('key'),{name:'SecurityError'});
});

test('Native prototype adapters accept shared virtual brands and preserve native receiver delegation',async()=>{
  const peer=await import('../src/frame/polyfill/storage.mjs?peer');
  const saved={keys:Object.keys,defineProperty:Object.defineProperty,defineProperties:Object.defineProperties,reflectDefine:Reflect.defineProperty};
  class NativeStorage{
    #values=new Map();
    get length(){return this.#values.size;}
    key(index){return [...this.#values.keys()][index]??null;}
    getItem(key){return this.#values.get(key)??null;}
    setItem(key,value){this.#values.set(key,value);}
    removeItem(key){this.#values.delete(key);}
    clear(){this.#values.clear();}
  }
  class PeerStorage extends NativeStorage{}
  // Give the peer its own prototype methods, as a separate realm would have.
  for(const key of ['length','key','getItem','setItem','removeItem','clear'])saved.defineProperty(PeerStorage.prototype,key,Object.getOwnPropertyDescriptor(NativeStorage.prototype,key));
  try{
    install_storage_prototype(NativeStorage);peer.install_storage_prototype(PeerStorage);
    const registry=new WeakMap(),storage=new FakeStorage([],()=>{},()=>{},{prototype:NativeStorage.prototype,registry});
    const other=new peer.FakeStorage([],()=>{},()=>{},{prototype:PeerStorage.prototype,registry});
    NativeStorage.prototype.setItem.call(other,'cross','saved');
    assert.equal(PeerStorage.prototype.getItem.call(storage,'cross'),null);
    assert.equal(other.getItem('cross'),'saved');assert.equal(other instanceof PeerStorage,true);
    assert.equal(storage.setItem,NativeStorage.prototype.setItem);
    const native=new NativeStorage();NativeStorage.prototype.setItem.call(native,'native','value');
    assert.equal(NativeStorage.prototype.getItem.call(native,'native'),'value');
    assert.throws(()=>NativeStorage.prototype.setItem.call(Object.create(NativeStorage.prototype),'bad','value'),TypeError);
    Object.defineProperty(storage,'defined',{value:23});assert.equal(storage.defined,'23');
    assert.equal(Reflect.defineProperty(storage,'reflected',{value:42}),true);assert.equal(storage.reflected,'42');
    assert.deepEqual(Object.entries(storage),[['defined','23'],['reflected','42']]);
    const ordinary={};Object.defineProperties(ordinary,{fixed:{value:7}});
    assert.equal(ordinary.fixed,7);assert.equal(Object.getOwnPropertyDescriptor(ordinary,'fixed').configurable,false);
    assert.equal(Reflect.defineProperty(ordinary,'fixed',{value:8}),false);
  }finally{
    Object.keys=saved.keys;Object.defineProperty=saved.defineProperty;Object.defineProperties=saved.defineProperties;Reflect.defineProperty=saved.reflectDefine;
  }
});
