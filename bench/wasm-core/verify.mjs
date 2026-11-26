import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {parse} from 'acorn';
import {runInThisContext} from 'node:vm';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadCore} from './bridge.mjs';
import {buildReference} from './reference.mjs';
import {fixtures as cssFixtures} from '../wasm-css/verify.mjs';

export const globals=['window','document','location','fetch','self','globalThis','importScripts','Worker','navigator','eval'];
export const options={contextName:'__ctx__',globalName:'__ctx__.__globals__',thisName:'__ctx__.__get_this__',directEval:true,url:'https://fixture.test/script.js'};
export function generatedCases(){
  let seed=0x1827;const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  const srcsets=['',' , , ','one.png,two.png','invalid.png future(a,b), valid.png 400w 200h',
    'first.png  400w,\n second.png 800w, data:image/png;base64,AAAA 2x','😀.png 1x,\ud800.png 2x'];
  const pieces=['a.png','data:image/svg+xml,a,b,c','comma,in,url',',',' ','\n','\t','1x','400w','future(a,b)','(',')','雪','😀','\ud800','\udfff'];
  const renders=[{source:'',edits:[[0,0,'a',1],[0,0,'b',-1],[0,0,'c',1]]},
    {source:'abcdef',edits:[[0,5,'outer'],[1,2,'overlap'],[5,5,'first',0.2],[5,5,'second',0.1],[6,6,'EOF']]},
    {source:'\ufeff😀x\ud800',edits:[[1,1,'\udfff'],[3,4,'雪']]}];
  const nodes=[{parts:[],edits:[]},{parts:['','',''],edits:[{start:0,end:0,value:'x'}]},
    {parts:['a','b','c','d'],edits:[{start:0,end:4,value:'one'}]},
    {parts:['','a','','b',''],edits:[{start:1,end:1,value:'insert'}]}];
  for(let i=0;i<1500;i++){
    let srcset='';for(let j=random(25);j>0;j--)srcset+=pieces[random(pieces.length)];srcsets.push(srcset);
    let source='';for(let j=random(50);j>0;j--)source+=pieces[random(pieces.length)];
    const edits=[];for(let j=random(20);j>0;j--){const a=random(source.length+1),b=a+random(source.length-a+1);edits.push([a,b,pieces[random(pieces.length)],(random(7)-3)/2]);}
    const begin=random(source.length+1),end=begin+random(source.length-begin+1);renders.push({source,edits,begin,end});
    // Text-node edits are disjoint token replacements, as produced by CSS.
    const parts=[];for(let at=0;at<source.length;){const size=random(8)+1;parts.push(source.slice(at,at+size));if(random(3)===0)parts.push('');at+=size;}
    const replacements=[];let cursor=0;
    while(cursor<source.length){const start=cursor+random(source.length-cursor),end=start+random(source.length-start+1);replacements.push({start,end,value:pieces[random(pieces.length)]});cursor=Math.max(end,start+1);}
    nodes.push({parts,edits:replacements.reverse()});
  }
  return {srcsets,renders,nodes};
}
export async function scriptCorpus(){
  const files=['node_modules/axios/dist/axios.min.js','node_modules/dexie/dist/dexie.min.js','node_modules/meriyah/dist/meriyah.umd.min.js'];
  const scripts=await Promise.all(files.map(async path=>({id:path.split('/')[1],path,source:await readFile(new URL('../../'+path,import.meta.url),'utf8')})));
  scripts.unshift({id:'scope-and-eval',source:`"use strict";function local(location){return location.href} const key='location';let {document:doc}=window; class Box{#value=1;read(){return this.#value+globalThis[key]}};window.result=eval('document.title');fetch('/api');`},
    {id:'with-and-import',source:`with(window){location.href='/next';eval('document.title')} import('./module.js').then(value=>window.result=value);`},
    {id:'unicode',source:`const café='😀';window[café]=document.title;function 雪(){return location.href}`});
  return scripts;
}
export async function regressionScripts(reference){
  const scripts=[],seen=new Set();
  const value=node=>node?.type==='Literal'&&typeof node.value==='string'?node.value:
    node?.type==='TemplateLiteral'&&!node.expressions.length?node.quasis[0].value.cooked:
    node?.type==='TaggedTemplateExpression'&&node.tag.type==='MemberExpression'&&node.tag.object.name==='String'&&node.tag.property.name==='raw'&&!node.quasi.expressions.length?node.quasi.quasis[0].value.raw:undefined;
  for(const file of await readdir(new URL('../../test/',import.meta.url))){
    if(!file.endsWith('.test.mjs')||!/(javascript|direct-eval|global-lexicals|function-sources|compatibility|module-private|script-labels)/.test(file))continue;
    const ast=parse(await readFile(new URL('../../test/'+file,import.meta.url),'utf8'),{ecmaVersion:'latest',sourceType:'module'});
    function visit(node){
      if(!node||typeof node!=='object')return;
      const candidate=node.type==='VariableDeclarator'&&['source','script','input'].includes(node.id?.name)?value(node.init):
        node.type==='CallExpression'&&node.callee.name==='rewrite_source'?value(node.arguments[0]):undefined;
      if(candidate!==undefined&&!seen.has(candidate)){seen.add(candidate);scripts.push({id:file+':'+node.start,source:candidate});}
      for(const item of Object.values(node))if(Array.isArray(item))item.forEach(visit);else if(item&&typeof item==='object')visit(item);
    }
    visit(ast);
  }
  const valid=[];globalThis.__wasmRender=reference.renderJS;
  try{
    for(const script of scripts){
      let expected,module=false;
      try{expected=reference.rewrite(script.source,globals,options)}catch(error){
        if(error.name!=='SyntaxError')throw error;
        try{module=true;expected=reference.rewrite(script.source,globals,{...options,module})}catch(error){if(error.name!=='SyntaxError')throw error;continue;}
      }
      valid.push({...script,module,expected});
    }
  }finally{delete globalThis.__wasmRender;}
  return valid;
}
export async function restoreCases(reference){
  const cases=[];
  for(const source of await cssFixtures()){
    const prepared=reference.prepareCSS(source,'native-restore-');
    cases.push({source:prepared.css,markers:[...prepared.markers],prefixes:false});
  }
  cases.push({source:'a{background:url(blob:one#fragment),url(blob:two);mask:url(blob:unknown)}',markers:[['blob:','prefix/'],['blob:one#fragment','exact.svg'],['blob:two','two.svg']],prefixes:true},
    {source:'@import "blob:one";a{background:url("blob:one#雪")}',markers:[['blob:one','https://site.test/😀.png']],prefixes:true},
    {source:'a{background:url(blob:one)}',markers:[['','fallback'],['blob:one','exact']],prefixes:true},
    {source:'a{background:url(blob:one)}',markers:[['blob:','first/'],['blob:one','second/']],prefixes:false});
  return cases;
}
export function verifyRestore(core,reference,cases){
  for(const {source,markers,prefixes}of cases){
    const map=new Map(markers);
    assert.equal(core.restore(source,map,undefined,prefixes),reference.restore(source,map,undefined,prefixes),'restore '+JSON.stringify(source));
    assert.equal(reference.restoreLinear(source,map,undefined,prefixes),reference.restore(source,map,undefined,prefixes),'linear restore '+JSON.stringify(source));
    assert.deepEqual(core.restore(source,map,edits=>edits,prefixes),reference.restore(source,map,edits=>edits,prefixes),'restore edits '+JSON.stringify(source));
    const parts=[];for(let i=0;i<source.length;i+=7)parts.push(source.slice(i,i+7));
    assert.deepEqual(core.restoreParts(parts,map,prefixes),reference.restore(source,map,edits=>reference.editParts(parts,edits),prefixes),'restore nodes '+JSON.stringify(source));
  }
}
export function verifyGenerated(core,reference,cases){
  for(const source of cases.srcsets)assert.deepEqual(core.srcset(source),reference.srcset(source),'srcset '+JSON.stringify(source));
  for(const {source,edits,begin=0,end=source.length}of cases.renders){
    // The production render() helper appends only the requested range.
    const localEdits=edits.filter(([a,b])=>a>=begin&&b<=end).map(([a,b,text,order])=>[a-begin,b-begin,text,order]);
    assert.equal(core.render(source,edits,begin,end),reference.renderJS(source.slice(begin,end),localEdits),'render '+JSON.stringify({source,edits,begin,end}));
  }
  for(const {parts,edits}of cases.nodes)assert.deepEqual(core.editParts(parts,edits),reference.editParts(parts,edits),'parts '+JSON.stringify({parts,edits}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const binary=await readFile(new URL('../../.temp/wasm-core/core.wasm',import.meta.url));
  const core=await loadCore(binary),reference=runInThisContext(await buildReference()+'\nSandstoneCoreReference;'),cases=generatedCases();
  verifyGenerated(core,reference,cases);
  const restoration=await restoreCases(reference);verifyRestore(core,reference,restoration);
  const regressions=await regressionScripts(reference);
  for(const script of regressions){globalThis.__wasmRender=core.render;assert.equal(reference.rewrite(script.source,globals,{...options,module:script.module}),script.expected,script.id);}
  const captured=[];
  for(const script of await scriptCorpus()){
    globalThis.__wasmRender=(source,edits,begin,end)=>{if(begin===undefined)captured.push({source,edits:edits.map(edit=>[...edit])});return reference.renderJS(source,edits,begin,end);};
    const expected=reference.rewrite(script.source,globals,options);
    globalThis.__wasmRender=core.render;
    assert.equal(reference.rewrite(script.source,globals,options),expected,'full rewrite '+script.id);
  }
  delete globalThis.__wasmRender;
  for(const {source,edits}of captured)assert.equal(core.render(source,edits),reference.renderJS(source,edits));
  console.log('Parity passed:',cases.srcsets.length,'srcsets,',cases.renders.length,'source edits,',cases.nodes.length,'CSS node edits,',restoration.length,'CSS restorations,',captured.length,'full script rewrites,',regressions.length,'existing JS regression inputs.');
}
