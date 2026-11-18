async page=>{
  const html='<!doctype html><body>Worker script scopes';
  const inspect=`const safe=read=>{try{return read()}catch(error){return error.name}};
    const descriptor=Object.getOwnPropertyDescriptor(self,'entryVar');
    self.startupImport={variable:safe(()=>entryVar),lexical:safe(()=>entryLexical),constant:safe(()=>entryConstant),model:safe(()=>new EntryModel().value),fn:safe(()=>entryFn()),publicFunction:typeof self.entryFn,variableConfigurable:descriptor?.configurable??null};
    self.importedFetch=fetch;`;
  const late=`self.lateImport={variable:entryVar,lexical:entryLexical,constant:entryConstant,fn:entryFn(),fetchValue:fetch.marker?fetch():'unpublished'};`;
  const classic=(strict,critical=false)=>`${strict?'"use strict";':''}
    var entryVar=7;let entryLexical=11;const entryConstant=13;
    class EntryModel{value=17}
    function entryFn(){return entryVar+entryLexical+entryConstant}
    function fetch(){return 'initial fetch'}fetch.marker='initial';
    self.runtimeCalls=[];
    ${critical?"function setTimeout(){self.runtimeCalls.push('timer')}function dispatchEvent(){self.runtimeCalls.push('dispatch')}function MessageEvent(){self.runtimeCalls.push('event')}\n":''}
    importScripts('./inspect.js');
    entryVar=19;entryLexical=23;fetch=()=> 'updated fetch';fetch.marker='updated';
    self.onmessage=async()=>{let nested;${critical?"const child=new Worker('./child.js');try{nested=await new Promise((resolve,reject)=>{child.onmessage=event=>resolve(event.data);child.onerror=event=>{event.preventDefault();reject(new Error(event.message))};child.postMessage(41)});}finally{child.terminate();}":''}let conflict;try{importScripts('./conflict.js')}catch(error){conflict=error.name}importScripts('./late.js');postMessage({startup:self.startupImport,late:self.lateImport,nested,conflict,conflictRan:!!self.conflictRan,publicFunction:self.entryFn===entryFn,publicFetch:self.fetch===fetch,importedFetch:self.importedFetch===fetch,values:[entryVar,entryLexical,entryConstant,new EntryModel().value],runtimeCalls:self.runtimeCalls,href:location.href})};`;
  const module=`import {inspect} from './module-inspect.js';
    var entryVar=7;let entryLexical=11;const entryConstant=13;
    class EntryModel{value=17}
    function entryFn(){return entryVar+entryLexical+entryConstant}
    function fetch(){return 'local fetch'}
    self.onmessage=()=>{let blocked;try{importScripts('./late.js')}catch(error){blocked=error.name}postMessage({imported:inspect(),publicFunction:typeof self.entryFn,publicFetch:self.fetch===fetch,values:[entryVar,entryLexical,entryConstant,new EntryModel().value,fetch()],blocked,href:location.href})};`;
  const probe=`'use strict';function resolveChunk(){return './computed.js'}importScripts('./probe-runtime.js');onmessage=()=>postMessage({computed:self.computedValue,shared:resolveChunk===self.resolveChunk,href:location.href});`;
  const files={'/strict.js':classic(true),'/sloppy.js':classic(false),'/critical.js':classic(false,true),'/child.js':'onmessage=event=>postMessage(event.data+1);','/inspect.js':inspect,'/late.js':late,'/conflict.js':'let entryLexical=99;self.conflictRan=true;','/module.js':module,'/probe.js':probe,'/probe-runtime.js':'importScripts(resolveChunk());','/computed.js':'self.computedValue=31;',
    '/module-inspect.js':`export function inspect(){return [typeof entryVar,typeof entryLexical,typeof entryConstant,typeof EntryModel,typeof entryFn]}`};
  const {createServer}=process.getBuiltinModule('node:http');let requests=0;
  const server=createServer((request,response)=>{requests++;const path=new URL(request.url,'http://127.0.0.1').pathname;response.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript':'text/html'});response.end(files[path]||html);});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  const url='http://127.0.0.1:'+server.address().port+'/';
  const context=await page.context().browser().newContext(),native=await context.newPage();
  const run=`(async()=>{const results=[];for(const file of ['strict','sloppy','critical','module','probe']){const worker=new Worker('/'+file+'.js',{type:file==='module'?'module':'classic'});try{const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Worker scope timed out: '+file)),5000);worker.onmessage=event=>{clearTimeout(timer);resolve(event.data)};worker.onerror=event=>{event.preventDefault();clearTimeout(timer);reject(new Error('Worker scope failed: '+file+': '+event.message))};worker.postMessage('run')});results.push({file,result});}finally{worker.terminate();}}return JSON.stringify(results)})()`;
  try{
    await native.goto(url);const expected=JSON.parse(await native.evaluate(source=>eval(source),run));
    await native.close();const nativeRequests=requests;
    await page.evaluate(({url,html,files})=>{const previous=sandstone.network.session.fetch;sandstone.network.session.fetch=(target,options)=>{const parsed=new URL(target);return parsed.origin===new URL(url).origin?Promise.resolve(new Response(files[parsed.pathname]||html,{headers:{'Content-Type':parsed.pathname.endsWith('.js')?'text/javascript':'text/html'}})):previous(target,options);};},{url,html,files});
    await page.evaluate(url=>main_frame.navigate_to(url),url);const actual=JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),run));
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Worker script scope parity: '+JSON.stringify({expected,actual}));
    if(requests!==nativeRequests)throw new Error('A proxied worker made a direct HTTP request');
    return ['Classic worker entries retain native global var, lexical, class and function scope across importScripts','Worker startup and message delivery retain native timers and events despite public API replacements','Module workers preserve local declarations and reject importScripts'];
  }finally{try{await context.close();}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
}
