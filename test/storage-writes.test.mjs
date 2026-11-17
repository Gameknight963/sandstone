import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeStorage} from '../src/frame/polyfill/storage.mjs';
import {SiteDataStore} from '../src/host/site_data.mjs';
import {apply_storage_change} from '../src/storage_changes.mjs';

test('Independent storage snapshots preserve writes and cannot resurrect deleted or cleared keys',()=>{
  const saved=new Map(),backend={getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)};
  const data=new SiteDataStore(backend),origin='https://storage.test';
  data.setLocal(origin,[['seed','1']]);
  const client=()=>new FakeStorage(data.local[origin],(_entries,change)=>data.changeLocal(origin,change));
  const left=client(),right=client();
  left.setItem('left','A');right.setItem('right','B');
  assert.deepEqual(new Map(data.local[origin]),new Map([['seed','1'],['left','A'],['right','B']]));
  left.removeItem('seed');right.setItem('right','updated');
  assert.equal(new Map(data.local[origin]).has('seed'),false);
  left.setItem('fresh','1');right.removeItem('fresh');
  assert.equal(new Map(data.local[origin]).has('fresh'),false);
  data.clear('storage.test');right.setItem('after-clear','new');
  assert.deepEqual(new SiteDataStore(backend).local[origin],[['after-clear','new']]);
});

test('Storage mutations preserve explicit clears, empty values, special keys and one-time coercion',()=>{
  let entries=[['old','1']],keys=0,values=0;
  const left=new FakeStorage(entries,(_snapshot,change)=>entries=apply_storage_change(entries,change));
  const right=new FakeStorage(entries,(_snapshot,change)=>entries=apply_storage_change(entries,change));
  left.clear();right.setItem({toString(){keys++;return '__proto__';}},{toString(){values++;return '';}});
  assert.deepEqual(entries,[['__proto__','']]);assert.equal(keys,1);assert.equal(values,1);
  assert.throws(()=>apply_storage_change(entries,{type:'set',key:'bad'}),TypeError);
  assert.deepEqual(entries,[['__proto__','']]);
});
