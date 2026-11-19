async page=>{
  const origin='https://module-private.test';
  const sources={
    '/module.js':String.raw`import settings from './data.json' with {type:'json'};
      const __ctx__={value:5},__get_this__=null,\u005f_sandstone_module_context__='authored';
      export class Widget{static observed=this.name;read(){const __ctx__=null,__get_this__=null;return [this instanceof Widget,this.constructor.name,__ctx__,__get_this__]}}
      export async function read(){const __ctx__=null,__get_this__=null;const late=await import('./late.js');return {locals:[__ctx__,__get_this__],alias:__sandstone_module_context__,page:location.pathname,meta:import.meta.url,late:late.value,json:settings.value,instance:new Widget().read(),className:Widget.observed,strict:(function(){return this})()===undefined};}
      export const value=__ctx__.value;`,
    '/late.js':`const __ctx__=null,__get_this__=null;export const value=import.meta.url;`,
    '/cycle-a.js':`import {readB} from './cycle-b.js';const __ctx__='cycle';export const value=7;export function read(){const __get_this__=null;return [__ctx__,readB(),import.meta.url,this===undefined,__get_this__]}`,
    '/cycle-b.js':`import {value} from './cycle-a.js';const __ctx__=null;export function readB(){return value}`,
    '/worker.js':`import {read} from './module.js';const __ctx__=null,__get_this__=null;onmessage=async()=>postMessage(await read());`,
    '/data.json':'{"value":42,"__ctx__":"data"}'
  };
  const plain='<!doctype html><body>Private module context fixture';
  const inline=plain+`<script type="module">import {read} from './module.js';const __ctx__=null,__get_this__=null;globalThis.inlineResult={value:await read(),meta:import.meta.url,locals:[__ctx__,__get_this__]};<\/script>`;
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route(origin+'/**',route=>{const path=new URL(route.request().url()).pathname;return route.fulfill({contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.json')?'application/json':'text/html',body:sources[path]||(path==='/inline'?inline:plain)});});
  await page.evaluate(({origin,sources,plain,inline})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(url,options)=>{
    if(new URL(url).origin!==origin)return previous(url,options);
    const path=new URL(url).pathname;return Promise.resolve(new Response(sources[path]||(path==='/inline'?inline:plain),{headers:{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.json')?'application/json':'text/html'}}));
  };},{origin,sources,plain,inline});
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const navigate=(proxy,path)=>proxy?page.evaluate(url=>main_frame.navigate_to(url),origin+path):native.goto(origin+path);
  const run=async proxy=>{
    await navigate(proxy,'/page');
    const external=await evaluate(proxy,`(async()=>{const module=await import('./module.js');return {value:module.value,read:await module.read()}})()`);
    const cycle=await evaluate(proxy,`(async()=>{const module=await import('./cycle-a.js');return (0,module.read)()})()`);
    await navigate(proxy,'/inline');
    const deadline=Date.now()+10000;
    while(!await evaluate(proxy,'typeof globalThis.inlineResult!=="undefined"')){if(Date.now()>deadline)throw new Error('Inline module context timed out');await new Promise(resolve=>setTimeout(resolve,20));}
    const inlineResult=await evaluate(proxy,'globalThis.inlineResult');
    await navigate(proxy,'/page');
    const worker=await evaluate(proxy,`new Promise((resolve,reject)=>{const worker=new Worker('/worker.js',{type:'module'});worker.onmessage=event=>{worker.terminate();resolve(event.data)};worker.onerror=event=>{event.preventDefault();worker.terminate();reject(new Error(event.message))};worker.postMessage(true);})`);
    return {external,cycle,inline:inlineResult,worker};
  };
  try{const expected=await run(false),actual=await run(true);if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Private module contexts differ: '+JSON.stringify({actual,expected}));return ['External, inline and cyclic document modules keep runtime helpers separate from authored locals','Acyclic module workers preserve local helper names, strict this and dynamic imports'];}
  finally{await context.close()}
}
