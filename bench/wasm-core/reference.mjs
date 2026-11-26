import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import webpack from 'webpack';

export async function buildReference(){
  const root=fileURLToPath(new URL('../../',import.meta.url)),out=resolve(root,'.temp/wasm-core');
  await mkdir(out,{recursive:true});
  const original=resolve(root,'src/frame/rewrite/javascript.mjs');
  const source=await readFile(original,'utf8');
  const start=source.indexOf('  edits.sort((a, b) => a[0] - b[0]');
  const end=source.indexOf('  // Bundlers may derive',start);
  if(start<0||end<0)throw new Error('Review the source renderer capture: production code changed.');
  const renderer=source.slice(start,end);
  if(!renderer.includes('output+=source.slice(offset);'))throw new Error('Incomplete renderer capture.');
  let captured=source.slice(0,start)+'  let output=globalThis.__wasmRender(source,edits);\n'+source.slice(end);
  const nestedStart=captured.indexOf('  const render=(start,end)=>{'),nestedEnd=captured.indexOf('  // Finish inner calls first',nestedStart);
  if(nestedStart<0||nestedEnd<0)throw new Error('Review the nested eval renderer capture.');
  const nestedRenderer=captured.slice(nestedStart,nestedEnd);
  captured=(captured.slice(0,nestedStart)+'  const render=(start,end)=>globalThis.__wasmRender(source,edits,start,end);\n'+captured.slice(nestedEnd))
    .replace(/from (["'])(\.\.?\/[^"']+)\1/g,(_,quote,path)=>'from '+JSON.stringify(resolve(dirname(original),path)));
  await writeFile(resolve(out,'captured.mjs'),captured);
  const cssPath=resolve(root,'src/frame/css.mjs'),css=await readFile(cssPath,'utf8');
  const restoreStart=css.indexOf('export function restore_css('),restoreEnd=css.indexOf('// Keep unaffected',restoreStart);
  const statement='source = source.slice(0, start) + replacement + source.slice(end);';
  let linear=css.slice(restoreStart,restoreEnd);
  if(restoreStart<0||restoreEnd<0||!linear.includes(statement))throw new Error('Review the CSS restore comparison: production code changed.');
  linear=linear.replace('export function restore_css(','export function restore_css_linear(').replace(statement,'/* Apply all edits once below. */')
    .replace('return transform ? transform(edits) : source;',`
    if(transform)return transform(edits);
    const chunks=[];let cursor=0;
    for(let i=edits.length-1;i>=0;i--){const {start,end,value}=edits[i];chunks.push(source.slice(cursor,start),value);cursor=end;}
    chunks.push(source.slice(cursor));return chunks.join('');`);
  await writeFile(resolve(out,'css-linear.mjs'),(css.slice(0,restoreStart)+linear)
    .replace(/from (["'])(\.\.?\/[^"']+)\1/g,(_,quote,path)=>'from '+JSON.stringify(resolve(dirname(cssPath),path))));
  const entry=`export {rewrite_source as rewrite} from './captured.mjs';
export {srcset_urls as srcset} from ${JSON.stringify(resolve(root,'src/frame/srcset.mjs'))};
export {edit_css_parts as editParts,prepare_css as prepareCSS,restore_css as restore} from ${JSON.stringify(resolve(root,'src/frame/css.mjs'))};
export {restore_css_linear as restoreLinear} from './css-linear.mjs';
export function renderJS(source,edits,begin=0,end=source.length){
if(arguments.length>2){${nestedRenderer}return render(begin,end);}
${renderer}return output;}
`;
  await writeFile(resolve(out,'entry.mjs'),entry);
  await new Promise((yes,no)=>{
    const compiler=webpack({mode:'production',target:'web',entry:resolve(out,'entry.mjs'),
      output:{path:out,filename:'reference.js',library:{name:'SandstoneCoreReference',type:'var'}},
      optimization:{minimize:false}});
    compiler.run((error,stats)=>compiler.close(closeError=>{
      if(error||closeError||stats.hasErrors())no(error||closeError||new Error(stats.toString({all:false,errors:true})));
      else yes();
    }));
  });
  return readFile(resolve(out,'reference.js'),'utf8');
}
