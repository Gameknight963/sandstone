import test from 'node:test';
import assert from 'node:assert/strict';
import {listen_runtime,unlisten_runtime,snapshot_runtime_events,restore_runtime_events,on_document_unload} from '../src/frame/runtime_events.mjs';

function lifecycle_target(){
  const listeners=new Map();
  return {
    addEventListener(type,callback){let entries=listeners.get(type);if(!entries)listeners.set(type,entries=[]);if(!entries.includes(callback))entries.push(callback);},
    removeEventListener(type,callback){listeners.set(type,(listeners.get(type)||[]).filter(value=>value!==callback));},
    emit(type,isTrusted){for(const callback of [...listeners.get(type)||[]])callback.call(this,{type,isTrusted});}
  };
}

test('Document cleanup ignores synthetic events without consuming the eventual trusted unload',()=>{
  const target=lifecycle_target(),seen=[],remove=on_document_unload(event=>seen.push(event.type),target);
  target.emit('beforeunload',true);target.emit('unload',false);target.emit('unload',false);
  assert.deepEqual(seen,[]);
  const snapshot=snapshot_runtime_events([target]);target.emit('unload',true);
  restore_runtime_events(snapshot);target.emit('unload',true);remove();
  assert.deepEqual(seen,['unload']);
});

test('Document cleanup can be cancelled and remains removed when a cleanup callback throws',()=>{
  const target=lifecycle_target(),seen=[],remove=on_document_unload(()=>seen.push('cancelled'),target);
  remove();target.emit('unload',true);assert.deepEqual(seen,[]);
  on_document_unload(()=>{seen.push('throwing');throw new Error('cleanup failed');},target);
  const snapshot=snapshot_runtime_events([target]);
  assert.throws(()=>target.emit('unload',true),/cleanup failed/);
  restore_runtime_events(snapshot);target.emit('unload',true);
  assert.deepEqual(seen,['throwing']);
});

test('Restoring runtime listeners is idempotent and never restores consumed once or aborted listeners',()=>{
  const target=new EventTarget(),controller=new AbortController(),seen=[];
  listen_runtime(target,'probe',()=>seen.push('once'),{once:true});
  listen_runtime(target,'probe',()=>seen.push('aborted'),{signal:controller.signal});
  const saved=snapshot_runtime_events([target]);controller.abort();target.dispatchEvent(new Event('probe'));
  restore_runtime_events(saved);restore_runtime_events(saved);target.dispatchEvent(new Event('probe'));
  assert.deepEqual(seen,['once']);
});

test('Removed runtime listeners cannot be revived by an earlier restoration snapshot',()=>{
  const target=new EventTarget(),seen=[],keep=()=>seen.push('keep'),removed=()=>seen.push('removed');
  listen_runtime(target,'probe',keep);listen_runtime(target,'probe',removed);
  const saved=snapshot_runtime_events([target]);unlisten_runtime(target,'probe',removed);
  target.removeEventListener('probe',keep);restore_runtime_events(saved);restore_runtime_events(saved);
  target.dispatchEvent(new Event('probe'));assert.deepEqual(seen,['keep']);unlisten_runtime(target,'probe',keep);
});
