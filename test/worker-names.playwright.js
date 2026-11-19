async page=>{
  const origin='https://worker-names.test',html='<!doctype html><body>Worker name fixture';
  const sources={
    '/root.js':`#!/usr/bin/env node
      import * as a from './a.js';import * as b from './b.js';onmessage=()=>postMessage({a:a.read(),b:b.read(),early:b.early,defaults:[a.default.name,b.default.name,b.default.observed],classes:[a.Component.name,a.Component.observed,a.Component.outerType,b.Component.name,b.Component.observed,b.Component.outerType],locals:b.locals(),reflection:b.reflect(),sources:[a.open.toString(),b.open.toString(),a.default.toString(),b.default.toString()]});`,
    '/a.js':`import * as b from './b.js';
      export function open(){return open.name}
      export const render=()=>render.name;
      export class Widget{static observed=this.name;static identity=this;}
      export const Component=class {static observed=this.name;static outerType=(()=>{try{return typeof Component}catch(error){return error.name}})();};
      export default function(){}
      export function read(){return [open.name,render.name,Widget.name,Widget.observed,Widget.identity===Widget,b.nested()];}`,
    '/b.js':`import {open as parentOpen} from './a.js';
      const __ctx__={local:true},__get_this__=null;
      export const early=parentOpen.name;
      export function open(){}
      export const render=function(){};
      export class Widget{static observed=this.name;}
      export const Component=class {static observed=this.name;static outerType=(()=>{try{return typeof Component}catch(error){return error.name}})();};
      export default class {static observed=this.name;}
      export function locals(){return [__ctx__.local,__get_this__]}
      export function nested(){const render=()=>parentOpen.name;switch(parentOpen.name){case open.name:function open(){};return [open.name,parentOpen.name,render.name];default:return ['wrong',open.name,render.name];}}
      export function reflect(){
        const __ctx__=null;let reads=0;const key={toString(){reads++;return 'dynamic'}},symbol=Symbol('component');
        const object={[key]:()=>0,[symbol]:function(){},get value(){return 0},set value(value){},method(){}};
        const descriptor=Object.getOwnPropertyDescriptor(open,'name');Object.defineProperty(open,'name',{value:'custom'});
        const custom=open.name;delete open.name;const deleted=open.name;Object.defineProperty(open,'name',descriptor);
        const named=function open(){return [open.name,parentOpen.name]};
        class Fields{field=()=>0;#private=()=>0;static field=function(){};read(){return [this.field.name,this.#private.name]}}
        class OwnName{static get name(){return 'kept'}static observed=this.name;}
        return {keyed:[reads,object.dynamic.name,object[symbol].name,Object.getOwnPropertyDescriptor(object,'value').get.name,Object.getOwnPropertyDescriptor(object,'value').set.name,object.method.name],
          mutation:[custom,deleted,open.name,open.bind(null).name],named:[named.name,named()],fields:[Fields.name,new Fields().read(),Fields.field.name],own:[OwnName.name,OwnName.observed],shadow:__ctx__,descriptor};
      }
      export function read(){return [open.name,render.name,Widget.name,Widget.observed];}`
  };
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route(origin+'/**',route=>route.fulfill({contentType:route.request().url().endsWith('.js')?'text/javascript':'text/html',body:sources[new URL(route.request().url()).pathname]||html}));
  await page.evaluate(({origin,sources,html})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(url,options)=>new URL(url).origin===origin?Promise.resolve(new Response(sources[new URL(url).pathname]||html,{headers:{'Content-Type':url.endsWith('.js')?'text/javascript':'text/html'}})):previous(url,options);},{origin,sources,html});
  const run=async proxy=>{
    if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),origin+'/page');else await native.goto(origin+'/page');
    const source=`new Promise((resolve,reject)=>{const worker=new Worker('/root.js',{type:'module'});worker.onmessage=event=>{worker.terminate();resolve(event.data)};worker.onerror=event=>{event.preventDefault();worker.terminate();reject(new Error(event.message))};worker.postMessage(true);})`;
    return proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  };
  try{const expected=await run(false),actual=await run(true);if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Worker function/class names differ: '+JSON.stringify({actual,expected}));return ['Cyclic worker functions and classes preserve authored names, static initialization and early reflection','Compiled worker context helpers remain separate from authored module and function locals'];}
  finally{await context.close()}
}
