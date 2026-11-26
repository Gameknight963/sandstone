import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {cpus,platform,arch} from 'node:os';
import {runInThisContext} from 'node:vm';
import {chromium,firefox} from 'playwright-core';
import {loadCore} from './bridge.mjs';
import {buildReference} from './reference.mjs';
import {generatedCases,verifyGenerated,restoreCases,verifyRestore,scriptCorpus,regressionScripts,globals,options} from './verify.mjs';

const root=new URL('../../',import.meta.url),out=new URL('.temp/wasm-core/',root);
await mkdir(out,{recursive:true});
const binary=await readFile(new URL('core.wasm',out)),bundle=await buildReference();
const core=await loadCore(binary),reference=runInThisContext(bundle+'\nSandstoneCoreReference;');
const cases=generatedCases(),scripts=await scriptCorpus();verifyGenerated(core,reference,cases);
const restoration=await restoreCases(reference);verifyRestore(core,reference,restoration);
const regressions=await regressionScripts(reference);
for(const script of regressions){globalThis.__wasmRender=core.render;if(reference.rewrite(script.source,globals,{...options,module:script.module})!==script.expected)throw new Error('Regression: '+script.id)}
const assembly=[];
for(const script of scripts){
  globalThis.__wasmRender=(source,edits,begin,end)=>{
    if(begin===undefined)assembly.push({id:script.id,source,edits:edits.map(edit=>[...edit])});return reference.renderJS(source,edits,begin,end);
  };
  script.expected=reference.rewrite(script.source,globals,options);
  globalThis.__wasmRender=core.render;
  if(reference.rewrite(script.source,globals,options)!==script.expected)throw new Error('Pipeline parity: '+script.id);
}
delete globalThis.__wasmRender;
const srcsets=[{id:'typical',source:'small-雪.png 400w, medium.png 800w, large.png 1600w, data:image/svg+xml,a,b 2x'},
  {id:'1000-candidates',source:Array.from({length:1000},(_,i)=>`image-${i}.png ${i+1}w`).join(', ')}];
const nodes=[];
for(const [id,length,count]of [['small',1000,8],['100k-12-nodes',100000,12],['100k-1000-nodes',100000,1000]]){
  const rule='.x{background:url(雪.png);mask:url(icon.svg#mark)}\n',source=rule.repeat(Math.ceil(length/rule.length));
  const size=Math.ceil(source.length/count),parts=[];
  for(let at=0;at<source.length;at+=size)parts.push(source.slice(at,at+size));
  nodes.push({id,parts,edits:reference.prepareCSS(source,'wasm-nodes-').edits});
}
const restoreInputs=[];
for(const [id,url]of [
  ['jquery-ui','https://cdn.jsdelivr.net/npm/jquery-ui-dist@1.13.3/jquery-ui.min.css'],
  ['fontawesome','https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.7.2/css/all.min.css']
]){
  const path=new URL(id+'.css',out);let css;
  try{css=await readFile(path,'utf8')}catch{const response=await fetch(url);if(!response.ok)throw new Error(url+': '+response.status);css=await response.text();await writeFile(path,css)}
  const prepared=reference.prepareCSS(css,'native-restore-');restoreInputs.push({id,url,sha256:createHash('sha256').update(css).digest('hex'),source:prepared.css,markers:[...prepared.markers]});
}
const dense=reference.prepareCSS('.x{background:url(雪.png);mask:url(icon.svg#mark)}\n'.repeat(2100),'native-restore-');
restoreInputs.push({id:'dense-100k',source:dense.css,markers:[...dense.markers]});
const declaration=reference.prepareCSS('url(icon.svg)','native-restore-');
restoreInputs.push({id:'small-declaration',source:declaration.css,markers:[...declaration.markers]});
for(const item of restoreInputs){
  item.parts=[];const size=Math.ceil(item.source.length/(item.id==='small-declaration'?1:12));
  for(let i=0;i<item.source.length;i+=size)item.parts.push(item.source.slice(i,i+size));
}
verifyRestore(core,reference,restoreInputs);
const bridge=(await readFile(new URL('bridge.mjs',import.meta.url),'utf8')).replace('export async function','async function');
const payload=JSON.stringify({binary:binary.toString('base64'),cases,restoration,restoreInputs,scripts,regressions,assembly,srcsets,nodes,globals,options}).replaceAll('<','\\u003c');
const harness=String.raw`
const {binary,cases,restoration,restoreInputs,scripts,regressions,assembly,srcsets,nodes,globals,options}=PAYLOAD;
const clock=performance.now(),core=await loadCore(Uint8Array.from(atob(binary),c=>c.charCodeAt(0))),initializationMs=performance.now()-clock;
const reference=SandstoneCoreReference;
const assert={equal(a,b,message){if(a!==b)throw new Error(message||'String mismatch')},deepEqual(a,b,message){if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(message||'Array mismatch')}};
VERIFY_GENERATED
verifyGenerated(core,reference,cases);
VERIFY_RESTORE
verifyRestore(core,reference,restoration);
verifyRestore(core,reference,restoreInputs);
for(const script of scripts){
  globalThis.__wasmRender=reference.renderJS;assert.equal(reference.rewrite(script.source,globals,options),script.expected,'JS pipeline '+script.id);
  globalThis.__wasmRender=core.render;assert.equal(reference.rewrite(script.source,globals,options),script.expected,'WASM pipeline '+script.id);
}
for(const script of regressions){
  const config={...options,module:script.module};globalThis.__wasmRender=reference.renderJS;assert.equal(reference.rewrite(script.source,globals,config),script.expected,'JS regression '+script.id);
  globalThis.__wasmRender=core.render;assert.equal(reference.rewrite(script.source,globals,config),script.expected,'WASM regression '+script.id);
}
for(const item of nodes)assert.deepEqual(core.editParts(item.parts,item.edits),reference.editParts(item.parts,item.edits));
delete globalThis.__wasmRender;
const encoder=new TextEncoder();let sink=0;
function consume(value,materialize){
  if(typeof value==='string')sink^=materialize?encoder.encode(value).length:value.length;
  else if(Array.isArray(value)){
    if(materialize)for(const part of value)sink^=encoder.encode(part).length;
    else sink^=value.length+(value[0]?.url?.length||value[0]?.length||0);
  }
}
function batch(fn,count,materialize){const start=performance.now();for(let i=0;i<count;i++)consume(fn(),materialize);return performance.now()-start;}
function median(values){return [...values].sort((a,b)=>a-b)[values.length>>1];}
const results=[];
function measure(category,id,js,wasm,metadata={},materialize=false,linear){
  const variants=[js,wasm,...(linear?[linear]:[])],counts=[],samples=variants.map(()=>[]);
  for(let v=0;v<variants.length;v++){
    let n=1,elapsed;
    do{elapsed=batch(variants[v],n,materialize);if(elapsed<25)n*=2;}while(elapsed<25&&n<32768);
    counts[v]=Math.max(1,Math.min(32768,Math.round(n*25/Math.max(elapsed,.01))));
  }
  for(let round=0;round<9;round++)for(let step=0;step<variants.length;step++){
    const v=(round+step)%variants.length;samples[v].push(batch(variants[v],counts[v],materialize)/counts[v]);
  }
  const timing=Object.fromEntries(['js','wasm',...(linear?['js-linear']:[])].map((name,v)=>[name,{medianMs:median(samples[v]),minMs:Math.min(...samples[v]),maxMs:Math.max(...samples[v]),iterations:counts[v],samplesMs:samples[v]}]));
  const result={category,id,...metadata,materializedUtf8:materialize,timing,speedup:timing.js.medianMs/timing.wasm.medianMs};results.push(result);
  console.log(category+' '+id+': '+result.speedup.toFixed(2)+'x');
}
for(const item of srcsets)measure('srcset',item.id,()=>reference.srcset(item.source),()=>core.srcset(item.source),{units:item.source.length});
for(const item of nodes){
  const metadata={units:item.parts.join('').length,nodes:item.parts.length,edits:item.edits.length};
  measure('css-nodes',item.id,()=>reference.editParts(item.parts,item.edits),()=>core.editParts(item.parts,item.edits),metadata);
  measure('css-nodes-utf8',item.id,()=>reference.editParts(item.parts,item.edits),()=>core.editParts(item.parts,item.edits),metadata,true);
}
for(const item of restoreInputs){
  const markers=new Map(item.markers),metadata={units:item.source.length,markers:markers.size,nodes:item.parts.length};
  measure('css-restore',item.id,()=>reference.restore(item.source,markers),()=>core.restore(item.source,markers),metadata,true,()=>reference.restoreLinear(item.source,markers));
  measure('css-restore-nodes',item.id,()=>reference.restore(item.parts.join(''),markers,edits=>reference.editParts(item.parts,edits)),()=>core.restoreParts(item.parts,markers),metadata,true,()=>reference.restoreLinear(item.parts.join(''),markers,edits=>reference.editParts(item.parts,edits)));
}
for(const item of assembly.filter(item=>['axios','dexie','meriyah'].includes(item.id))){
  const js=()=>reference.renderJS(item.source,[...item.edits]),wasm=()=>core.render(item.source,item.edits);
  const metadata={units:item.source.length,edits:item.edits.length};
  measure('js-assembly',item.id,js,wasm,metadata);
  measure('js-assembly-utf8',item.id,js,wasm,metadata,true);
}
for(const script of scripts){
  const js=()=>{globalThis.__wasmRender=reference.renderJS;return reference.rewrite(script.source,globals,options)};
  const wasm=()=>{globalThis.__wasmRender=core.render;return reference.rewrite(script.source,globals,options)};
  measure('js-pipeline',script.id,js,wasm,{units:script.source.length},true);
}
delete globalThis.__wasmRender;
globalThis.benchmarkResult={initializationMs,correctness:{srcsets:cases.srcsets.length,renders:cases.renders.length,nodes:cases.nodes.length,restores:restoration.length,scripts:scripts.length,regressions:regressions.length},results,sink};
`;
const code=bridge+'\n'+harness.replace('PAYLOAD',payload).replace('VERIFY_GENERATED',verifyGenerated.toString()).replace('VERIFY_RESTORE',verifyRestore.toString());
const html='<!doctype html><meta charset="utf-8"><title>Sandstone native rewrite core</title><script src="data:text/javascript;base64,'+Buffer.from(bundle).toString('base64')+'"></script><script type="module">try{'+code+'}catch(error){globalThis.benchmarkError=error.stack||String(error)}</script>';
const pagePath=new URL('benchmark.html',out);await writeFile(pagePath,html);
const hash=value=>createHash('sha256').update(value).digest('hex');
const report={date:new Date().toISOString(),node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,
  wasmBytes:binary.length,wasmGzipBytes:gzipSync(binary).length,wasmSha256:hash(binary),globals,options,
  scripts:scripts.map(({expected,source,...script})=>({...script,units:source.length,sha256:hash(source)})),browsers:{}};
report.stylesheets=restoreInputs.map(({source,parts,markers,...item})=>({...item,units:source.length,markers:markers.length,nodes:parts.length}));
report.sourceHashes=Object.fromEntries(await Promise.all(['src/frame/css.mjs','src/frame/srcset.mjs','src/frame/rewrite/javascript.mjs','bench/wasm-css/css.cpp','bench/wasm-core/core.cpp','bench/wasm-core/bridge.mjs','bench/wasm-core/reference.mjs','bench/wasm-core/exports.json'].map(async path=>[path,hash(await readFile(new URL(path,root)))])));
for(const [name,engine]of Object.entries({firefox,chromium})){
  const browser=await engine.launch({headless:true});
  try{
    console.log('Benchmarking',name,browser.version());const page=await browser.newPage();
    page.on('console',message=>{if(message.type()==='log')console.log(name+':',message.text())});
    page.on('pageerror',error=>console.error(name+':',error.message));
    await page.goto(pagePath.href,{waitUntil:'commit'});
    await page.waitForFunction(()=>globalThis.benchmarkResult||globalThis.benchmarkError,null,{timeout:240000});
    const error=await page.evaluate(()=>globalThis.benchmarkError);if(error)throw new Error(error);
    report.browsers[name]={version:browser.version(),...await page.evaluate(()=>benchmarkResult)};
  }finally{await browser.close();}
  await writeFile(new URL('results.json',out),JSON.stringify(report,null,2)+'\n');
}
console.log('Saved .temp/wasm-core/results.json');
