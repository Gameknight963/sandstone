import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {cpus,platform,arch} from 'node:os';
import {gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {chromium,firefox} from 'playwright-core';
import {fixtures,check} from './verify.mjs';
import {loadWasm} from './bridge.mjs';

const root=new URL('../../',import.meta.url),out=new URL('.temp/wasm-css/',root);
await mkdir(out,{recursive:true});
const files=[
  ['normalize','https://cdn.jsdelivr.net/npm/normalize.css@8.0.1/normalize.css'],
  ['bootstrap','https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css'],
  ['bulma','https://cdn.jsdelivr.net/npm/bulma@1.0.2/css/bulma.min.css'],
  ['jquery-ui','https://cdn.jsdelivr.net/npm/jquery-ui-dist@1.13.3/jquery-ui.min.css'],
  ['fontawesome','https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.7.2/css/all.min.css'],
];
const corpus=[];
for(const [id,url]of files){
  const path=new URL(id+'.css',out);
  let text;try{text=await readFile(path,'utf8');}catch{
    const response=await fetch(url);if(!response.ok)throw new Error(url+': '+response.status);
    text=await response.text();await writeFile(path,text);
  }
  corpus.push({id,url,sha256:createHash('sha256').update(text).digest('hex'),text});
}
const realistic=String.raw`/* URLs inside comments url(ignore) */
@import "theme.css" layer(theme) supports(display:grid) screen;
@font-face{font-family:example;src:local("Example"),url(fonts/雪.woff2) format("woff2")}
.icon{background:image-set("one.png" 1x type("image/png"),url(two.png) 2x);mask:u\72l(icon.svg\#mark)}
.text::after{content:"😀 url(ignored)";background:url("https://example.test/image (one).png")}
`;
corpus.push({id:'mixed-small',text:realistic},
  {id:'mixed-100k',text:realistic.repeat(Math.ceil(100000/realistic.length))});
if(process.env.BENCH_LARGE==='1')corpus.push({id:'mixed-1m',text:realistic.repeat(Math.ceil(1000000/realistic.length))});

const binary=await readFile(new URL('css.wasm',out)),wasm=await loadWasm(binary),cases=await fixtures();
for(const [i,source]of cases.entries())check(wasm,source,'fixture '+i);
for(const source of corpus)check(wasm,source.text,source.id);
console.log('Correctness passed:',cases.length+corpus.length,'inputs.');

// Execute the unmodified production functions, not a handwritten JS imitation.
const full=await readFile(new URL('src/frame/css.mjs',root),'utf8');
const reference=full.slice(0,full.indexOf('export function restore_css')).replace(/^import .*\r?\n/gm,'').replace(/^export /gm,'');
const originalLoop='for (const {start, end, value} of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, start) + value + source.slice(end);';
if(!reference.includes(originalLoop))throw new Error('Production prepare_css changed; review the linear comparison.');
const linear=reference.slice(reference.indexOf('function prepare_css(')).replace('function prepare_css(','function prepare_css_linear(').replace(originalLoop,`
  edits.sort((a,b)=>b.start-a.start);
  const chunks=[];let cursor=0;
  for(let i=edits.length-1;i>=0;i--){const {start,end,value}=edits[i];chunks.push(source.slice(cursor,start),value);cursor=end;}
  chunks.push(source.slice(cursor));source=chunks.join('');`);
const bridge=(await readFile(new URL('bridge.mjs',import.meta.url),'utf8')).replace('export async function','async function');
const payload=JSON.stringify({corpus,cases,binary:binary.toString('base64')}).replaceAll('<','\\u003c');
const harness=String.raw`
const {corpus,cases,binary}=PAYLOAD;
const clock=performance.now();
const bytes=Uint8Array.from(atob(binary),c=>c.charCodeAt(0));
const wasm=await loadWasm(bytes);const initializationMs=performance.now()-clock;
const prefix='sandstone-wasm-';
const stable=value=>JSON.stringify(value,(_,v)=>v instanceof Map?[...v]:v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
for(const source of [...cases,...corpus.map(item=>item.text)]){
  if(stable(wasm.scan(source))!==stable(css_references(source)))throw new Error('Browser scan parity failed: '+source.slice(0,200));
  const expected=stable(prepare_css(source,prefix));
  if(stable(wasm.prepare(source,prefix))!==expected)throw new Error('Browser WASM rewrite parity failed');
  if(stable(prepare_css_linear(source,prefix))!==expected)throw new Error('Browser linear JS parity failed');
}
let sink=0;
function consume(value){sink^=typeof value==='number'?value:Array.isArray(value)?value.length:value.css.length+value.markers.size+value.edits.length;}
function batch(fn,count){const start=performance.now();for(let i=0;i<count;i++)consume(fn());return performance.now()-start;}
function median(values){return [...values].sort((a,b)=>a-b)[values.length>>1];}
const results=[];
for(const item of corpus)for(const operation of ['scan','prepare']){
  const source=item.text;
  const variants=operation==='scan'?[
    ['js',()=>css_references(source)],['wasm',()=>wasm.scan(source)],['wasm-resident',wasm.residentScan(source)]
  ]:[['js',()=>prepare_css(source,prefix)],['js-linear',()=>prepare_css_linear(source,prefix)],
    ['wasm',()=>wasm.prepare(source,prefix)],['wasm-resident',wasm.residentPrepare(source,prefix)]];
  // Resident calls share the input buffer: every other variant uses this same
  // source/prefix, and no variant changes it to another corpus entry mid-group.
  const count=[],samples=variants.map(()=>[]);
  for(let v=0;v<variants.length;v++){
    let n=1,elapsed;
    do{elapsed=batch(variants[v][1],n);if(elapsed<30)n*=2;}while(elapsed<30&&n<65536);
    count[v]=Math.max(1,Math.min(65536,Math.round(n*30/Math.max(elapsed,.01))));
  }
  // Rotate execution order to avoid giving one implementation every cold batch.
  for(let round=0;round<9;round++)for(let step=0;step<variants.length;step++){
    const v=(round+step)%variants.length;samples[v].push(batch(variants[v][1],count[v])/count[v]);
  }
  const timings=Object.fromEntries(variants.map(([id],i)=>[id,{medianMs:median(samples[i]),minMs:Math.min(...samples[i]),maxMs:Math.max(...samples[i]),iterations:count[i],samplesMs:samples[i]}]));
  results.push({id:item.id,operation,units:source.length,references:css_references(source).length,rewrites:prepare_css(source,prefix).markers.size,timings,wasmSpeedup:timings.js.medianMs/timings.wasm.medianMs});
  console.log('Completed '+item.id+' '+operation);
}
globalThis.benchmarkResult={initializationMs,correctnessInputs:cases.length+corpus.length,results,sink};
`;
const html='<!doctype html><meta charset="utf-8"><title>Sandstone CSS WASM experiment</title><script type="module">try{'+reference+'\n'+linear+'\n'+bridge+'\n'+harness.replace('PAYLOAD',payload)+'\n}catch(error){globalThis.benchmarkError=error.stack||String(error)}\n</script>';
const htmlPath=new URL('benchmark.html',out);await writeFile(htmlPath,html);
const reports={date:new Date().toISOString(),node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,
  wasmBytes:binary.length,wasmGzipBytes:gzipSync(binary).length,wasmSha256:createHash('sha256').update(binary).digest('hex'),baselineCssSha256:createHash('sha256').update(full).digest('hex'),
  corpus:corpus.map(({text,...item})=>({...item,units:text.length,utf8Bytes:Buffer.byteLength(text)})),browsers:{}};
for(const [name,engine]of Object.entries({firefox,chromium})){
  const browser=await engine.launch({headless:true});
  try{
    console.log('Benchmarking',name,browser.version());
    const page=await browser.newPage();
    page.on('console',message=>{if(message.type()==='log')console.log(name+':',message.text());});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(htmlPath.href,{waitUntil:'commit'});
    await page.waitForFunction(()=>globalThis.benchmarkResult||globalThis.benchmarkError,null,{timeout:300000});
    const failure=await page.evaluate(()=>globalThis.benchmarkError);if(failure)throw new Error(failure);
    if(errors.length)throw new Error(errors.join('\n'));
    const report=await page.evaluate(()=>benchmarkResult);reports.browsers[name]={version:browser.version(),...report};
    for(const row of report.results)console.log(name,row.id,row.operation,'JS',row.timings.js.medianMs.toFixed(3),'ms; WASM',row.timings.wasm.medianMs.toFixed(3),'ms;',row.wasmSpeedup.toFixed(2)+'x');
  }finally{await browser.close();}
  await writeFile(new URL('results.json',out),JSON.stringify(reports,null,2)+'\n');
}
console.log('Results:',fileURLToPath(new URL('results.json',out)));
