import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

// Separate contexts model frame realms. This dependency-free module can run
// as a script after removing its export modifiers, without experimental VM APIs.
const source=(await readFile(new URL('../../src/frame/global_reflection.mjs',import.meta.url),'utf8')).replace(/^export /gm,'');
const root=vm.createContext({});
vm.runInContext(source,root);
vm.runInContext('register_global_reflection({},{});',root);
const group=vm.runInContext('get_global_reflection_group()',root);
function child(){
  const realm=vm.createContext({parent:{document:{},sandstone_frame:{context:{get_global_reflection_group:()=>group}}}});
  vm.runInContext(source,realm);
  vm.runInContext('globalThis.alias={};register_global_reflection(alias,{describe:key=>key==="navigator"?{value:"virtual",configurable:true}:undefined});',realm);
  return {reference:new WeakRef(vm.runInContext('globalThis',realm)),alias:vm.runInContext('alias',realm)};
}
async function collect(){for(let attempt=0;attempt<12;attempt++){await new Promise(resolve=>setImmediate(resolve));global.gc();}}
const sample=child();
root.foreign=sample.alias;
await collect();
assert.equal(vm.runInContext('Object.getOwnPropertyDescriptor(foreign,"navigator").value',root),'virtual','A live borrowed reflection method lost the child registry');
assert.ok(sample.reference.deref(),'A referenced child realm was collected');
delete root.foreign;sample.alias=null;
await collect();
assert.equal(sample.reference.deref()===undefined,true,'The shared registry retained an otherwise unreachable child realm');
assert.equal(vm.runInContext('Object.getOwnPropertyDescriptor({},"missing")',root),undefined,'Pruning a dead registry broke ordinary reflection');

const fallback=vm.createContext({WeakRef:undefined});
vm.runInContext(source,fallback);
assert.equal(vm.runInContext('globalThis.alias={};register_global_reflection(alias,{describe:()=>({value:"fallback"})});Object.getOwnPropertyDescriptor(alias,"navigator").value',fallback),'fallback','Reflection stopped working without native weak references');
