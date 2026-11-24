import assert from 'node:assert/strict';
import {wait_for} from './wait-for.mjs';

export async function verifyDocumentCycles(page){
  const origin='https://document-cycles.test',url=origin+'/page';
  const html='<!doctype html><title>Document module cycles</title><body><script type="module" src="/entry.js"></script>';
  const sources={
    '/entry.js':`import * as a from './a.js';globalThis.initial=a;globalThis.moduleReady=true;`,
    '/a.js':`import {read} from './b.js';globalThis.aRuns=(globalThis.aRuns||0)+1;export let count=1;export function bump(){count++}export function fromB(){return read()}export const url=import.meta.url;export default {value:42};`,
    '/b.js':`import {count} from './a.js';export function read(){return count}`,
    '/lazy-a.js':`import * as a from './a.js';import {other} from './lazy-b.js';export {a};export function own(){return 3}export function read(){return a.count+other()}`,
    '/lazy-b.js':`import {own} from './lazy-a.js';export function other(){return own()}`,
    '/async-a.js':`import {valueB} from './async-b.js';export function hoisted(){return 'function'}export const value=await Promise.resolve('A'+valueB);`,
    '/async-b.js':`import {hoisted} from './async-a.js';export const valueB=hoisted()==='function'?'B':'wrong';`,
    '/then-a.js':`import './then-b.js';export function then(resolve){globalThis.thenCalls=(globalThis.thenCalls||0)+1;resolve(77)}`,
    '/then-b.js':`import './then-a.js';`,
    '/tdz-a.js':`import './tdz-b.js';export let value=1;`,
    '/tdz-b.js':`import {value} from './tdz-a.js';globalThis.unexpectedTDZ=value;`
  };
  const native=await page.context().newPage(),fixture=await page.context().newPage(),errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
  const evaluate=(proxy,source)=>proxy?fixture.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  try{
    await native.route(origin+'/**',route=>route.fulfill({contentType:route.request().url().endsWith('.js')?'text/javascript':'text/html',body:sources[new URL(route.request().url()).pathname]||html}));
    await native.goto(url);await native.waitForFunction(()=>globalThis.moduleReady);
    await fixture.route(/^https?:/,route=>route.abort('blockedbyclient'));await fixture.goto(page.url());
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.evaluate(async({url,sources,html})=>{
      sandstone.network.session.fetch=async url=>new Response(sources[new URL(url).pathname]||html,{headers:{'content-type':url.endsWith('.js')?'text/javascript':'text/html'}});
      await main_frame.navigate_to(url);
    },{url,sources,html});
    await wait_for(()=>evaluate(true,'globalThis.moduleReady===true'));
    const run=proxy=>evaluate(proxy,`(async()=>{
      const a=await import('./a.js'),lazy=await import('./lazy-a.js');a.bump();
      const async=await import('./async-a.js');const then=await import('./then-a.js');
      let tdz;try{await import('./tdz-a.js');tdz='missing'}catch(error){tdz=error.name}
      const descriptor=Object.getOwnPropertyDescriptor(a,'count');
      return JSON.stringify({same:initial===a,lazySame:lazy.a===a,count:a.count,read:a.fromB(),lazy:lazy.read(),runs:aRuns,
        async:async.value,then,thenCalls,tdz,url:a.url,source:a.bump.toString(),keys:Object.keys(a),tag:Object.prototype.toString.call(a),
        nullPrototype:Object.getPrototypeOf(a)===null,descriptor:{value:descriptor.value,writable:descriptor.writable,enumerable:descriptor.enumerable,configurable:descriptor.configurable}});
    })()`);
    const expected=JSON.parse(await run(false)),actual=JSON.parse(await run(true));
    assert.deepEqual(actual,expected);assert.equal(actual.async,'AB');assert.equal(actual.tdz,'ReferenceError');assert.equal(actual.same,true);assert.equal(actual.lazySame,true);assert.equal(actual.then,77);assert.equal(actual.thenCalls,1);
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Document module cycles and later cyclic chunks retain live bindings and shared native namespace identity','Document cycles preserve top-level await, TDZ, then exports, function sources and virtual import metadata without additional import maps'];
  }finally{await fixture.close();await native.close();}
}
