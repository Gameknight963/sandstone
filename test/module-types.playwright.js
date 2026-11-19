async page=>{
  const origin='https://module-types.test',html='<!doctype html><body>Typed module identity fixture';
  const sources={
    '/data':{type:'application/json',body:'{"value":42}'},
    '/parallel':{type:'application/json',body:'{"value":43}'},
    '/partial':{type:'application/json',body:'{"value":44}'},
    '/code':{type:'text/javascript',body:'export const value=17;'},
    '/sheet':{type:'text/css',body:'body{color:red}'},
    '/wrapper.js':{type:'text/javascript',body:`export {default as data} from '/data' with {'type':'json'};export {value} from '/code';`},
    '/style.js':{type:'text/javascript',body:`export {default} from '/sheet' with {type:'css'};`},
    '/partial.js':{type:'text/javascript',body:`import data from '/partial' with {type:'json'};import '/partial';export default data;`},
    '/cycle-a.js':{type:'text/javascript',body:`import {read} from '/cycle-b.js';import data from '/data' with {type:'json'};export const value=7;export function result(){return [read(),data.value]}`},
    '/cycle-b.js':{type:'text/javascript',body:`import {value} from '/cycle-a.js';export function read(){return value}`},
    '/unknown.js':{type:'text/javascript',body:`import '/code' with {unknown:'yes'};export const value=99;`},
    '/explicit-js.js':{type:'text/javascript',body:`export * from '/code' with {type:'javascript'};`},
    '/empty-type.js':{type:'text/javascript',body:`import '/code' with {type:''};export const value=99;`}
  };
  const exercise=`(async()=>{
    const status=async(specifier,options)=>{try{await import(specifier,options);return 'ok'}catch(error){return error.name}};
    const wrong=await status('/data'),data=(await import('/data',{with:{type:'json'}})).default;
    const wrongJSON=await status('/code',{with:{type:'json'}}),wrapper=await import('/wrapper.js');
    const parallel=await Promise.all([status('/parallel'),import('/parallel',{with:{type:'json'}}).then(module=>module.default.value)]);
    const partial=await status('/partial.js'),remaining=(await import('/partial',{with:{type:'json'}})).default;
    const cycle=await import('/cycle-a.js');
    const invalid=[];for(const path of ['/unknown.js','/explicit-js.js','/empty-type.js'])invalid.push(await status(path));
    return {wrong,wrongJSON,value:data.value,wrapper:wrapper.value,identity:wrapper.data===data,repeated:(await import('/data',{with:{type:'json'}})).default===data,parallel,partial,remaining:remaining.value,cycle:cycle.result(),invalid};
  })()`;
  sources['/worker.js']={type:'text/javascript',body:`onmessage=async()=>{try{postMessage({result:await ${exercise}})}catch(error){postMessage({error:error.stack})}};`};
  const context=await page.context().browser().newContext(),native=await context.newPage();
  await context.route(origin+'/**',route=>{const source=sources[new URL(route.request().url()).pathname];return route.fulfill({contentType:source?.type||'text/html',body:source?.body||html});});
  await page.evaluate(({origin,sources,html})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(url,options)=>{
    if(new URL(url).origin!==origin)return previous(url,options);
    const source=sources[new URL(url).pathname];return Promise.resolve(new Response(source?.body||html,{headers:{'Content-Type':source?.type||'text/html'}}));
  };},{origin,sources,html});
  const run=async proxy=>{
    if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),origin+'/page');else await native.goto(origin+'/page');
    const evaluate=source=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
    const result=await evaluate(exercise);
    const style=await evaluate(`(async()=>{let rejected;try{await import('/sheet');rejected=false}catch(error){rejected=error.name}const sheet=(await import('/sheet',{with:{type:'css'}})).default,wrapper=await import('/style.js');return {rejected,color:sheet.cssRules[0].style.color,same:sheet===wrapper.default}})()`);
    const workers=[];
    for(const type of ['classic','module']){
      const worker=await evaluate(`new Promise((resolve,reject)=>{const worker=new Worker('/worker.js',{type:${JSON.stringify(type)}});worker.onmessage=event=>{worker.terminate();resolve(event.data)};worker.onerror=event=>{event.preventDefault();worker.terminate();reject(new Error(event.message))};worker.postMessage(true)})`);
      if(!worker.result)throw new Error('Typed worker failed: '+JSON.stringify(worker));
      workers.push(worker);
    }
    return {result,style,workers};
  };
  try{const expected=await run(false),actual=await run(true);if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Module type identity differs: '+JSON.stringify({actual,expected}));return ['Module failures are isolated by URL and type while matching imports retain shared identity','Typed static imports, re-exports and cyclic worker graphs resolve after an incompatible import fails','Unsupported static module attributes fail before executing their graph'];}
  finally{await context.close()}
}
