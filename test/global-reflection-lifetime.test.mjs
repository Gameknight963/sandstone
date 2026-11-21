import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('Shared Window reflection registries preserve live frame aliases without retaining discarded realms',()=>{
  const result=spawnSync(process.execPath,['--expose-gc',fileURLToPath(new URL('./fixtures/reflection-lifetime.mjs',import.meta.url))],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);
});
