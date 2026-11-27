// Compare the actual shipped CSS APIs, including routing and async responses.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {cpus} from 'node:os';
import webpack from 'webpack';
import {chromium,firefox} from 'playwright-core';
const root=fileURLToPath(new URL('../',import.meta.url)),out=resolve(root,'.temp/native-css-runtime');await mkdir(out,{recursive:true});
const cssPath=resolve(root,'src/frame/css.mjs'),css=await readFile(cssPath,'utf8');
const hook='const native=native_apply_css(source,references,values)';if(!css.includes(hook))throw new Error('Review the assembly comparison');
await writeFile(resolve(out,'without-assembly.mjs'),css.replace(hook,'const native=null').replace(/from (["'])(\.\.?\/[^"']+)\1/g,(_,quote,path)=>'from '+JSON.stringify(resolve(dirname(cssPath),path))));
const srcsetPath=resolve(root,'src/frame/srcset.mjs'),srcset=await readFile(srcsetPath,'utf8');
const srcsetHook='const native=native_rewrite_srcset(input,urls)';if(!srcset.includes(srcsetHook))throw new Error('Review srcset assembly comparison');
await writeFile(resolve(out,'srcset-without-assembly.mjs'),srcset.replace(srcsetHook,'const native=null').replace(/from (["'])(\.\.?\/[^"']+)\1/g,(_,quote,path)=>'from '+JSON.stringify(resolve(dirname(srcsetPath),path))));
const bundles={};
for(const name of ['baseline','scanOnly','native']){
  const entry=`export * from ${JSON.stringify(name==='scanOnly'?resolve(out,'without-assembly.mjs'):cssPath)};
export {srcset_urls,rewrite_srcset} from ${JSON.stringify(name==='scanOnly'?resolve(out,'srcset-without-assembly.mjs'):srcsetPath)};
export {initialize_native_css,native_css_status} from ${JSON.stringify(resolve(root,'src/native/css.mjs'))};`;
  const entryPath=resolve(out,name+'.mjs');await writeFile(entryPath,entry);
  await new Promise((yes,no)=>{const compiler=webpack({mode:'production',target:'web',entry:entryPath,output:{path:out,filename:name+'.js',library:{name:'CSS_'+name,type:'var'}},optimization:{minimize:false}});compiler.run((error,stats)=>compiler.close(closeError=>error||closeError||stats.hasErrors()?no(error||closeError||new Error(stats.toString({all:false,errors:true}))):yes()));});
  bundles[name]=(await readFile(resolve(out,name+'.js'))).toString('base64');
}
const inputs=[];
for(const [id,url]of [['jquery-ui','https://cdn.jsdelivr.net/npm/jquery-ui-dist@1.13.3/jquery-ui.min.css'],['fontawesome','https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.7.2/css/all.min.css']]){
  const path=resolve(out,id+'.css');let source;try{source=await readFile(path,'utf8')}catch{const response=await fetch(url);if(!response.ok)throw new Error(url);source=await response.text();await writeFile(path,source)}inputs.push({id,url,source});
}
const rule='.x{background:url(icon.svg);mask:url(mask.svg#part)}\n';
inputs.push({id:'medium',source:rule.repeat(160)},{id:'dense-100k',source:rule.repeat(2000)},
  {id:'conditional-imports',source:'@import "yes.css" supports(display:grid);@import "no.css" supports(unknown:value);\n'.repeat(80)},
  {id:'small',source:'a{background:url(icon.svg)}'});
inputs.push({id:'images-small',kind:'srcset',source:'small.png 400w, medium.png 800w, large.png 1600w'},
  {id:'images-1000',kind:'srcset',source:Array.from({length:1000},(_,index)=>'image-'+index+'.png '+(index+1)+'w').join(', ')});
const binary=await readFile(resolve(root,'vendor/native/css.wasm'));
const payload=JSON.stringify({inputs,binary:binary.toString('base64')}).replaceAll('<','\\u003c');
const code=String.raw`
const {inputs,binary}=PAYLOAD,apis={js:CSS_baseline,scanOnly:CSS_scanOnly,wasm:CSS_native};
const bytes=Uint8Array.from(atob(binary),c=>c.charCodeAt(0));
await apis.scanOnly.initialize_native_css(bytes);await apis.wasm.initialize_native_css(bytes);
if(!apis.wasm.native_css_status().ready)throw new Error('Native CSS not ready');
const supports=condition=>condition==='display:grid',encoder=new TextEncoder();let sink=0;
const services={supports,async fetch(url){return new Response(url.endsWith('.css')?'a{color:red}':'image',{headers:{'content-type':url.endsWith('.css')?'text/css':'image/png'}})},createURL:()=> 'blob:resolved'};
const stable=value=>JSON.stringify(value,(_,v)=>v instanceof Map?[...v]:v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const same=(a,b)=>stable(a)===stable(b);
const results=[];
for(const input of inputs){
  const prepared=input.kind==='srcset'?null:apis.js.prepare_css(input.source,'runtime-',supports);
  for(const operation of input.kind==='srcset'?['srcset-scan','srcset-resolve']:['prepare','restore','resolve']){
    const fn=api=>operation==='srcset-scan'?()=>api.srcset_urls(input.source):operation==='srcset-resolve'?()=>api.rewrite_srcset(input.source,async url=>'blob:'+url):operation==='prepare'?()=>api.prepare_css(input.source,'runtime-',supports):operation==='restore'?()=>api.restore_css(prepared.css,prepared.markers):()=>api.rewrite_css(input.source,'https://bench.test/',services);
    const functions=Object.values(apis).map(fn),expected=await functions[0]();
    for(const run of functions)if(!same(expected,await run()))throw new Error('Parity: '+input.id+' '+operation);
    const batch=async(run,count)=>{const start=performance.now();for(let i=0;i<count;i++){const value=await run();sink^=encoder.encode(Array.isArray(value)?value.map(ref=>ref.url).join(','):typeof value==='string'?value:value.css).length;}return performance.now()-start;};
    const counts=[],samples=functions.map(()=>[]);
    for(let v=0;v<functions.length;v++){let count=1,elapsed;do{elapsed=await batch(functions[v],count);if(elapsed<20)count*=2;}while(elapsed<20&&count<8192);counts[v]=Math.max(1,Math.min(8192,Math.round(count*20/Math.max(elapsed,.01))));}
    for(let round=0;round<7;round++)for(let step=0;step<functions.length;step++){const v=(round+step)%functions.length;samples[v].push(await batch(functions[v],counts[v])/counts[v]);}
    const timing=Object.fromEntries(Object.keys(apis).map((name,i)=>[name,{medianMs:[...samples[i]].sort((a,b)=>a-b)[3],samplesMs:samples[i]}]));
    results.push({id:input.id,operation,units:input.source.length,resources:input.kind==='srcset'?apis.js.srcset_urls(input.source).length:apis.js.css_resource_references(input.source).length,timing});
    console.log(input.id+' '+operation+': '+(timing.js.medianMs/timing.wasm.medianMs).toFixed(2)+'x; assembly '+(timing.scanOnly.medianMs/timing.wasm.medianMs).toFixed(2)+'x');
  }
}
globalThis.result={results,sink,status:apis.wasm.native_css_status()};
`;
const scripts=Object.values(bundles).map(value=>'<script src="data:text/javascript;base64,'+value+'"></script>').join('');
const pagePath=resolve(out,'benchmark.html');await writeFile(pagePath,'<!doctype html><meta charset="utf-8">'+scripts+'<script type="module">try{'+code.replace('PAYLOAD',payload)+'}catch(error){globalThis.failure=error.stack||String(error)}</script>');
const hash=value=>createHash('sha256').update(value).digest('hex'),report={date:new Date().toISOString(),cpu:cpus()[0]?.model,binarySha256:hash(binary),inputs:inputs.map(({source,...input})=>({...input,sha256:hash(source),units:source.length})),browsers:{}};
for(const [name,engine]of Object.entries({firefox,chromium})){
  const browser=await engine.launch({headless:true});
  try{const page=await browser.newPage();page.on('console',message=>console.log(name+':',message.text()));await page.goto(pathToFileURL(pagePath).href,{waitUntil:'commit'});await page.waitForFunction(()=>globalThis.result||globalThis.failure,null,{timeout:240000});const failure=await page.evaluate(()=>globalThis.failure);if(failure)throw new Error(failure);report.browsers[name]={version:browser.version(),...await page.evaluate(()=>result)};}
  finally{await browser.close();}
  await writeFile(resolve(out,'results.json'),JSON.stringify(report,null,2)+'\n');
}
