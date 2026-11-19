async page=>{
  const origin='https://worker-cycles.test',url=origin+'/page';
  const sources={
    '/root.js':`import * as initial from './a.js';import {read} from './b.js';import {value} from './async-a.js';
      onmessage=async()=>{try{
        const a=await import('./a.js'),later=await import('./later.js');a.bump();
        const lazy=await import('./lazy-a.js');
        let freeze;try{Object.freeze(a);freeze='succeeded'}catch(error){freeze=error.name}
        const descriptor=Object.getOwnPropertyDescriptor(a,'count');
        postMessage({same:initial===a,later:later.namespace===a,reexport:later.exported===a,default:later.default===a.default,
          count:a.count,read:read(),async:value,lazy:lazy.read(),lazySame:lazy.namespace===a,runs:globalThis.aRuns,
          keys:Object.keys(a),tag:Object.prototype.toString.call(a),nullPrototype:Object.getPrototypeOf(a)===null,
          source:a.bump.toString(),url:import.meta.url,descriptor:{value:descriptor.value,writable:descriptor.writable,enumerable:descriptor.enumerable,configurable:descriptor.configurable},frozen:Object.isFrozen(a),freeze});
      }catch(error){postMessage({error:error.name,message:error.message,stack:error.stack});}};`,
    '/a.js':`import {read} from './b.js';globalThis.aRuns=(globalThis.aRuns||0)+1;
      export let count=1;export function bump(){count++}export function fromB(){return read()}export default {value:42};`,
    '/b.js':`import {count} from './a.js';export function read(){return count}`,
    '/async-a.js':`import {valueB} from './async-b.js';export function hoisted(){return 'function'}export const value=await Promise.resolve('A'+valueB);`,
    '/async-b.js':`import {hoisted} from './async-a.js';export const valueB=hoisted()==='function'?'B':'wrong';`,
    '/later.js':`import value,* as namespace from './a.js';export {namespace};export * as exported from './a.js';export default value;`,
    '/lazy-a.js':`import * as namespace from './a.js';import {other} from './lazy-b.js';export {namespace};export function read(){return namespace.count+other()}export function own(){return 3}`,
    '/lazy-b.js':`import {own} from './lazy-a.js';export function other(){return own()}`,
    '/classic.js':`const describe=Object.prototype.toString;var Object=function AuthoredObject(){},Symbol=function AuthoredSymbol(){};
      onmessage=async()=>{try{const a=await import('./a.js');a.bump();postMessage({value:a.count,read:a.fromB(),tag:describe.call(a),names:[Object.name,Symbol.name]})}catch(error){postMessage({error:error.message})}};`,
    '/empty-root.js':`import './empty-a.js';onmessage=async()=>postMessage({keys:Object.keys(await import('./empty-a.js')),ready:true});`,
    '/empty-a.js':`'use client';import './empty-b.js';`,
    '/empty-b.js':`import './empty-a.js';`,
    '/then-root.js':`import './then-side.js';globalThis.thenCalls=0;export function then(resolve){globalThis.thenCalls++;resolve(99)}
      onmessage=async()=>{const value=await import('./then-a.js');postMessage({startup:globalThis.thenCalls,dynamic:globalThis.dynamicThenCalls,value})};`,
    '/then-side.js':`import './then-root.js';`,
    '/then-a.js':`import './then-b.js';export function then(resolve){globalThis.dynamicThenCalls=(globalThis.dynamicThenCalls||0)+1;resolve(77)}`,
    '/then-b.js':`import './then-a.js';`,
    '/acyclic-then.js':`globalThis.acyclicStartup=0;export function then(resolve){globalThis.acyclicStartup++;resolve(99)}onmessage=()=>postMessage({calls:globalThis.acyclicStartup});`,
    '/tdz-a.js':`import './tdz-b.js';export let value=1;`,
    '/tdz-b.js':`import {value} from './tdz-a.js';postMessage({unexpected:value});`
  };
  const html='<!doctype html><body>Module worker cycle fixture';
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route(origin+'/**',route=>route.fulfill({contentType:route.request().url().endsWith('.js')?'text/javascript':'text/html',body:sources[new URL(route.request().url()).pathname]||html}));
  await page.evaluate(({origin,sources,html})=>{
    const previous=sandstone.network.session.fetch;
    sandstone.network.session.fetch=(url,options)=>new URL(url).origin===origin?Promise.resolve(new Response(sources[new URL(url).pathname]||html,{headers:{'Content-Type':url.endsWith('.js')?'text/javascript':'text/html'}})):previous(url,options);
  },{origin,sources,html});
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const run=async proxy=>{
    if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),url);else await native.goto(url);
    const result=JSON.parse(await evaluate(proxy,`new Promise((resolve,reject)=>{
      const worker=new Worker('/root.js',{type:'module'});
      worker.onmessage=event=>{worker.terminate();resolve(JSON.stringify(event.data));};
      worker.onerror=event=>{event.preventDefault();worker.terminate();reject(new Error(event.message));};worker.postMessage(true);
    })`));
    if(result.error)throw new Error(JSON.stringify(result));
    const tdz=await evaluate(proxy,`new Promise(resolve=>{const worker=new Worker('/tdz-a.js',{type:'module'});worker.onmessage=()=>{worker.terminate();resolve(false)};worker.onerror=event=>{event.preventDefault();worker.terminate();resolve(/before initialization/.test(event.message))};})`);
    const extra=JSON.parse(await evaluate(proxy,`(async()=>{
      const run=(url,type)=>new Promise((resolve,reject)=>{const worker=new Worker(url,{type});worker.onmessage=event=>{worker.terminate();resolve(event.data)};worker.onerror=event=>{event.preventDefault();worker.terminate();reject(new Error(event.message))};worker.postMessage(true)});
      return JSON.stringify({classic:await run('/classic.js','classic'),empty:await run('/empty-root.js','module'),then:await run('/then-root.js','module'),acyclicThen:await run('/acyclic-then.js','module')});
    })()`));
    return {result,tdz,extra};
  };
  try{
    const expected=await run(false),actual=await run(true);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Cyclic module workers differ: '+JSON.stringify({actual,expected}));
    if(!actual.tdz||!actual.result.same||!actual.result.later||!actual.result.lazySame||actual.result.count!==2||actual.result.async!=='AB')throw new Error('Native cycle expectations failed: '+JSON.stringify(actual));
    if(actual.extra.classic.error||actual.extra.classic.value!==2||actual.extra.then.startup!==0||actual.extra.then.dynamic!==1||actual.extra.acyclicThen.calls!==0)throw new Error('Native worker startup expectations failed: '+JSON.stringify(actual.extra));
    return ['Module workers retain cyclic live bindings, hoisted functions, top-level await and TDZ errors','Cyclic worker modules keep namespace identity across later native chunks and dynamic cycles','Cyclic worker graphs retain authored function sources and virtual import metadata','Classic workers load module cycles after global constructor replacements; empty cycles and directives remain valid','Worker namespaces retain native descriptors and freeze failures; then exports run only for dynamic imports'];
  }finally{await context.close()}
}
