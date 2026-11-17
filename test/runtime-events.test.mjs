import test from 'node:test';
import assert from 'node:assert/strict';
import {listen_runtime,unlisten_runtime,snapshot_runtime_events,restore_runtime_events} from '../src/frame/runtime_events.mjs';

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
