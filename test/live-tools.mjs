import assert from 'node:assert/strict';
import {documentSites,interactDocumentTool} from './live-documents.mjs';
import {gameSites,interactGame} from './live-games.mjs';
import {search_sites,interactSearchPortal} from './live-search.mjs';
import {scratchSites,interactScratch} from './live-scratch.mjs';
import {paintFileSites,interactPaintFiles} from './live-paint-files.mjs';
import {markdownSites,interactMarkdown} from './live-markdown.mjs';

export const tool_sites=[
  ...documentSites,
  ...gameSites,
  ...search_sites,
  ...scratchSites,
  ...paintFileSites,
  ...markdownSites,
  {id:'squoosh',url:'https://squoosh.app/',editor:true},
  {id:'sqlime',url:'https://sqlime.org/',editor:true}
];

export async function interact_tool(page,proxy,site,{surface,read,wait}){
  if(documentSites.some(tool=>tool.id===site.id))return interactDocumentTool(page,proxy,site,{surface,read,wait});
  if(gameSites.some(game=>game.id===site.id))return interactGame(page,proxy,site,{surface,read,wait});
  if(search_sites.some(search=>search.id===site.id))return interactSearchPortal(page,proxy,{surface,read,wait});
  if(scratchSites.some(editor=>editor.id===site.id))return interactScratch(page,proxy,{surface,read,wait});
  if(paintFileSites.some(editor=>editor.id===site.id))return interactPaintFiles(page,proxy,{surface,read,wait});
  if(markdownSites.some(editor=>editor.id===site.id))return interactMarkdown(page,proxy,site,{surface,read,wait});
  if(site.id==='sqlime'){
    const editor=surface.locator('#editor');await editor.fill("create table numbers(value); insert into numbers values (6),(7); select sum(value) as answer from numbers;");
    await surface.getByRole('button',{name:'run',exact:true}).click();
    await wait(page,proxy,'!!Array.from(document.querySelectorAll("td")).find(cell=>cell.textContent.trim()==="13")');
    await editor.fill('select count(*) as rows, max(value) as largest from numbers;');await surface.getByRole('button',{name:'run',exact:true}).click();
    await wait(page,proxy,'Array.from(document.querySelectorAll("th")).some(cell=>cell.textContent.trim()==="largest")');
    const values=await read(page,proxy,'Array.from(document.querySelectorAll("tbody td")).map(cell=>cell.textContent.trim())');
    assert.deepEqual(values,['2','7']);return {created:true,inserted:true,sum:13,values};
  }
  const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=128;canvas.height=96;const context=canvas.getContext('2d');for(let y=0;y<96;y++){context.fillStyle='rgb('+y*2+',80,180)';context.fillRect(0,y,128,1);}return canvas.toDataURL().split(',')[1];});
  await surface.locator('input[type=file]').setInputFiles({name:'sandstone.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  const jpeg='a[download="sandstone.jpg"][href^="blob:"]',webp='a[download="sandstone.webp"][href^="blob:"]';
  await wait(page,proxy,'!!document.querySelector('+JSON.stringify(jpeg)+')');
  const initial=await read(page,proxy,'document.querySelector('+JSON.stringify(jpeg)+').getAttribute("href")');
  await surface.locator('select').last().selectOption('webP');
  await wait(page,proxy,'!!document.querySelector('+JSON.stringify(webp)+')');
  const source='(async()=>{const link=document.querySelector('+JSON.stringify(webp)+'),response=await fetch(link.href),blob=await response.blob(),bytes=new Uint8Array(await blob.arrayBuffer()),bitmap=await createImageBitmap(blob);const result={name:link.download,type:blob.type,width:bitmap.width,height:bitmap.height,signature:String.fromCharCode(...bytes.slice(0,4)),format:String.fromCharCode(...bytes.slice(8,12)),changed:link.href!=='+JSON.stringify(initial)+'};bitmap.close();return JSON.stringify(result);})()';
  const image=JSON.parse(proxy?await page.evaluate(source=>main_frame.eval_js(source),source):await page.evaluate(source=>eval(source),source));
  assert.deepEqual(image,{name:'sandstone.webp',type:'image/webp',width:128,height:96,signature:'RIFF',format:'WEBP',changed:true});
  const download=page.waitForEvent('download');await surface.locator('a[download="sandstone.webp"]').click();const saved=await download;assert.equal(saved.suggestedFilename(),'sandstone.webp');assert.equal(await saved.failure(),null);
  return {...image,downloaded:true};
}
