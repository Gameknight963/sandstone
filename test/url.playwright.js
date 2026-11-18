async page=>{
  const html='<!doctype html><body>URL API fixture';
  const sample=`(()=>{
    const inspect=value=>value===null?null:{href:value.href,origin:value.origin,instance:value instanceof URL,prototype:Object.getPrototypeOf(value)===URL.prototype,constructor:value.constructor===URL,params:value.searchParams instanceof URLSearchParams};
    const results=[],record=(name,fn)=>{const trace=[];try{results.push({name,value:fn(trace),trace})}catch(error){results.push({name,error:error.name,trace})}};
    record('identity',()=>({name:URL.name,length:URL.length,constructor:URL.prototype.constructor===URL,prototype:Object.getPrototypeOf(URL.prototype)===Object.prototype,keys:Reflect.ownKeys(URL).filter(key=>typeof key==='string').sort()}));
    for(const name of ['constructor','toString','__proto__','hasOwnProperty','child?q=1#part'])record('relative '+name,()=>inspect(new URL(name,'https://url.test/base/')));
    const string=(trace,label,value)=>({[Symbol.toPrimitive](hint){trace.push(label+':'+hint);return value}});
    record('conversion',trace=>inspect(new URL(string(trace,'url','../item?a=1'),string(trace,'base','https://url.test/base/'))));
    record('URL override',trace=>{const value=new URL('https://old.test/');value.toString=()=>{trace.push('custom string');return 'https://new.test/'};return inspect(new URL(value))});
    record('throwing href',trace=>inspect(new URL({get href(){throw new Error('href read')},toString(){trace.push('toString');return 'https://url.test/'}})));
    record('missing argument',()=>new URL());record('symbol',()=>new URL(Symbol('url')));
    record('conversion failure',trace=>new URL({[Symbol.toPrimitive](){trace.push('url');throw new RangeError('conversion')}},string(trace,'base','https://url.test/')));
    record('ignored arguments',trace=>inspect(new URL('/path','https://url.test/',string(trace,'ignored','unused'))));
    record('subclass',()=>{class Derived extends URL{}const value=new Derived('/path','https://url.test/');return {href:value.href,base:value instanceof URL,derived:value instanceof Derived,prototype:Object.getPrototypeOf(value)===Derived.prototype,constructor:value.constructor===Derived,super:Object.getPrototypeOf(Derived)===URL}});
    record('live search params',()=>{const value=new URL('https://url.test/?a=1');const params=value.searchParams;params.append('a','2');value.search='?b=3';return {href:value.href,same:params===value.searchParams,values:[...params]}});
    for(const method of ['parse','canParse'])if(typeof URL[method]==='function'){
      const original=URL[method];record(method+' descriptor',()=>{const d=Object.getOwnPropertyDescriptor(URL,method);return {same:d.value===original,name:original.name,length:original.length,writable:d.writable,enumerable:d.enumerable,configurable:d.configurable}});
      record(method+' conversion',trace=>{const value=original.call(null,string(trace,'url','/path'),string(trace,'base','https://url.test/'));return method==='parse'?inspect(value):value});
      record(method+' invalid',trace=>{const value=original(string(trace,'url','http://['),string(trace,'base','https://url.test/'));return method==='parse'?inspect(value):value});
      record(method+' symbol',()=>original(Symbol('url')));record(method+' missing',()=>original());
      record(method+' subclass',()=>{class Derived extends URL{}const value=Derived[method]('https://url.test/');return method==='parse'?{...inspect(value),derived:value instanceof Derived}:value});
    }
    const blob=new Blob(['url fixture']);const local=URL.createObjectURL(blob);record('object URL',()=>{const result={blob:local.startsWith('blob:'),href:new URL(local).href===local};URL.revokeObjectURL(local);return result});
    record('frozen constructor',()=>{Object.freeze(URL);return {frozen:Object.isFrozen(URL),created:inspect(new URL('https://url.test/')),parsed:typeof URL.parse==='function'?inspect(URL.parse('https://url.test/')):null,canParse:typeof URL.canParse==='function'?URL.canParse('https://url.test/'):null}});
    return results;
  })()`;
  const {createServer}=process.getBuiltinModule('node:http');let requests=0;
  const server=createServer((request,response)=>{requests++;const worker=request.url==='/worker.js';response.writeHead(200,{'Content-Type':worker?'text/javascript':'text/html'});response.end(worker?'postMessage('+sample+');':html)});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  const url='http://127.0.0.1:'+server.address().port+'/';
  const context=await page.context().browser().newContext(),native=await context.newPage();
  const run='(async()=>{const windowResult='+sample+';const worker=new Worker("/worker.js");try{const workerResult=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("URL worker timed out")),5000);worker.onmessage=event=>{clearTimeout(timer);resolve(event.data)};worker.onerror=event=>{event.preventDefault();clearTimeout(timer);reject(new Error(event.message))}});return JSON.stringify({window:windowResult,worker:workerResult})}finally{worker.terminate()}})()';
  try{
    await native.goto(url);const expected=JSON.parse(await native.evaluate(source=>eval(source),run));await native.close();const nativeRequests=requests;
    await page.evaluate(({url,html,sample})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(target,options)=>{const parsed=new URL(target);return parsed.origin===new URL(url).origin?Promise.resolve(new Response(parsed.pathname==='/worker.js'?'postMessage('+sample+');':html,{headers:{'Content-Type':parsed.pathname==='/worker.js'?'text/javascript':'text/html'}})):previous(target,options)};},{url,html,sample});
    await page.evaluate(url=>main_frame.navigate_to(url),url);const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),run));
    for(const mode of ['window','worker'])for(let index=0;index<expected[mode].length;index++)if(JSON.stringify(actual[mode][index])!==JSON.stringify(expected[mode][index]))throw new Error('URL API parity ('+mode+'): '+JSON.stringify({expected:expected[mode][index],actual:actual[mode][index]}));
    if(requests!==nativeRequests)throw new Error('A proxied URL fixture made a direct HTTP request');
    return ['URL construction, coercion, inheritance and live search params match native windows and workers','URL.parse and URL.canParse retain native objects, descriptors, validation and argument order'];
  }finally{try{await context.close()}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}}
}
