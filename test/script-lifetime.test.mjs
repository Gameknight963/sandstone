import test from 'node:test';
import assert from 'node:assert/strict';
import {delay_script_load,pending_script_loads,wait_script_loads} from '../src/frame/script_lifetime.mjs';

test('Script load waiting includes scripts prepared by completion microtasks',async()=>{
  const first=delay_script_load();let child,finished=false;
  const waiting=wait_script_loads().then(()=>finished=true);
  queueMicrotask(()=>child=delay_script_load());first();
  await Promise.resolve();await Promise.resolve();
  assert.equal(pending_script_loads(),true);assert.equal(finished,false);
  child();await waiting;assert.equal(pending_script_loads(),false);
});

test('Retired document waiters cancel without discarding shared script lifetimes',async()=>{
  const finish=delay_script_load(),controller=new AbortController();let currentFinished=false;
  const retired=wait_script_loads(controller.signal),current=wait_script_loads().then(()=>currentFinished=true);
  controller.abort();await retired;
  assert.equal(pending_script_loads(),true);assert.equal(currentFinished,false);
  finish();finish();await current;assert.equal(pending_script_loads(),false);
  await wait_script_loads(controller.signal);
});
