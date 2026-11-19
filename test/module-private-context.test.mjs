import test from 'node:test';
import assert from 'node:assert/strict';
import {ModuleLoader} from '../src/frame/modules.mjs';
import {rewrite_source} from '../src/frame/rewrite/javascript.mjs';

test('Native module graphs isolate encoded helper aliases and share one trusted context across lazy imports',async()=>{
  const base='https://private-unit.test/',sources={
    'main.js':String.raw`#!/usr/bin/env node
      import data from './data.json' with {type:'json'};
      const __ctx__=null,__get_this__=null,\u005f_sandstone_module_context__='authored';
      export class Widget{static observed=this.name;read(){const __ctx__=null,__get_this__=null;return [this.constructor.name,__ctx__,__get_this__]}}
      export async function read(){const __ctx__=null,__get_this__=null;const late=await import('./late.js');return {locals:[__ctx__,__get_this__],alias:__sandstone_module_context__,url:location.href,meta:import.meta.url,late:late.value,json:data.value,instance:new Widget().read(),className:Widget.observed,strict:(function(){return this})()===undefined};}`,
    'late.js':'const __ctx__=null,__get_this__=null;export const value=import.meta.url;',
    'data.json':'{"value":42,"__ctx__":"data"}'
  };
  let contexts=0;const requests=[];
  const loader=new ModuleLoader({
    fetch:async url=>{requests.push(url);return new Response(sources[url.slice(base.length)],{headers:{'Content-Type':url.endsWith('.json')?'application/json':'text/javascript'}});},
    rewrite:(source,options)=>rewrite_source(source,['location'],{...options,globalName:options.contextName+'.__globals__'}),
    createURL:source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64'),
    contextModule(){contexts++;return 'data:text/javascript;base64,'+Buffer.from('export default __ctx__;\n//# sourceURL=private-unit-context').toString('base64');},
    register(){throw new Error('Acyclic graph used an import map')},execute:url=>import(url)
  });
  const previous=globalThis.__ctx__;
  const context={__get_this__:value=>value,__globals__:{location:new URL(base+'page')},__json_module__:JSON.parse,__module_meta__:url=>loader.meta(url),__import__:(parent,specifier,options)=>loader.import(specifier,parent,options)};
  globalThis.__ctx__=context;loader.preamble='__ctx__.visits=(__ctx__.visits||0)+1;';
  try{
    const module=await loader.import('./main.js',base),result=await module.read();
    assert.deepEqual(result,{locals:[null,null],alias:'authored',url:base+'page',meta:base+'main.js',late:base+'late.js',json:42,instance:['Widget',null,null],className:'Widget',strict:true});
    assert.equal(await loader.import('./main.js',base),module);assert.deepEqual(await module.read(),result);
    assert.equal(contexts,1);assert.equal(context.visits,3);assert.equal(requests.length,3);
  }finally{if(previous===undefined)delete globalThis.__ctx__;else globalThis.__ctx__=previous;}
});

test('A failed context factory cannot mark a module usable or poison later preparation',async()=>{
  let fail=true,fetches=0;const sources=new Map();
  const loader=new ModuleLoader({
    fetch:async()=>{fetches++;return new Response('export const value=1;',{headers:{'Content-Type':'text/javascript'}});},
    rewrite:(source,options)=>rewrite_source(source,[],options),
    createURL(source){const url='blob:prepared/'+sources.size;sources.set(url,source);return url;},
    contextModule(){if(fail)throw new Error('Context unavailable');return 'blob:private-context';},
    register(){throw new Error('Unexpected import map')},execute(){throw new Error('Preparation executed code')}
  });
  await assert.rejects(loader.prepare_url('./main.js','https://private-retry.test/'),/Context unavailable/);
  assert.equal(loader.get_record('https://private-retry.test/main.js').blob,null);assert.equal(sources.size,0);
  fail=false;const record=await loader.prepare_url('./main.js','https://private-retry.test/');
  assert.ok(record.blob);assert.equal(fetches,1);assert.ok(sources.get(record.blob).includes('from "blob:private-context"'));
});
