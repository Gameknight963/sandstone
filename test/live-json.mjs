import assert from 'node:assert/strict';

export const jsonSites=[{id:'jsoncrack',url:'https://jsoncrack.com/editor',editor:true,timeout:90000}];
const sample={project:'Sandstone',ready:true,items:[{name:'alpha',value:42},{name:'beta',value:7}],notes:'caf\u00e9 \u20ac'};
const graph='document.querySelector(\'foreignObject [data-key="project: Sandstone"]\')?.closest("svg")';

export async function interactJson(page,proxy,{surface,read,wait}){
  await surface.locator('input[type=file]').setInputFiles({name:'sandstone.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(sample,null,2))});
  await wait(page,proxy,'!!document.querySelector(\'foreignObject [data-key="value: 42"]\')');
  await surface.locator('.view-line').filter({hasText:/"value":\s*42/}).first().click();
  await page.keyboard.press('End');await page.keyboard.press('Backspace');await page.keyboard.press('Backspace');await page.keyboard.type('43');
  await wait(page,proxy,'!!document.querySelector(\'foreignObject [data-key="value: 43"]\')');
  const toggle=()=>surface.locator('foreignObject [data-collapse-path]').filter({hasText:/^[−+]$/}).first();
  await toggle().click();await wait(page,proxy,'('+graph+')?.querySelectorAll("foreignObject[data-id]").length===1');
  await toggle().click();await wait(page,proxy,'('+graph+')?.querySelectorAll("foreignObject[data-id]").length===3');
  assert.equal(await read(page,proxy,'!!document.querySelector(\'foreignObject [data-key="value: 43"]\')'),true);
  const exports=[];
  for(const format of ['SVG','PNG']){
    await surface.getByRole('button',{name:'export',exact:true}).click();const dialog=surface.getByRole('dialog');await dialog.waitFor();
    await dialog.getByLabel('File Name',{exact:true}).fill('sandstone-graph');await dialog.getByText(format,{exact:true}).click();
    const pending=page.waitForEvent('download');await dialog.getByRole('button',{name:'Download',exact:true}).click();const download=await pending;
    assert.equal(await download.failure(),null);const chunks=[];for await(const chunk of await download.createReadStream())chunks.push(chunk);const bytes=Buffer.concat(chunks),name=download.suggestedFilename();assert.ok(name.endsWith('.'+format.toLowerCase()),name);
    let image;
    if(format==='SVG'){
      image=await page.evaluate(text=>{const doc=new DOMParser().parseFromString(text,'image/svg+xml'),root=doc.documentElement;return {svg:root.localName==='svg',width:Number.parseFloat(root.getAttribute('width')),height:Number.parseFloat(root.getAttribute('height')),labels:[...doc.querySelectorAll('[data-key]')].map(node=>node.getAttribute('data-key')).sort()};},bytes.toString('utf8'));
      assert.equal(image.svg,true);for(const label of ['project: Sandstone','ready: true','name: alpha','value: 43','name: beta','value: 7','notes: café €'])assert.ok(image.labels.includes(label),label);
    }else{
      assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
      image=await page.evaluate(async bytes=>{const bitmap=await createImageBitmap(new Blob([Uint8Array.from(bytes)],{type:'image/png'})),canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d');context.drawImage(bitmap,0,0);const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;let ink=0;for(let index=0;index<pixels.length;index+=4)if(pixels[index+3]&&Math.min(pixels[index],pixels[index+1],pixels[index+2])<220)ink++;bitmap.close();const digest=await crypto.subtle.digest('SHA-256',pixels);return {width:canvas.width,height:canvas.height,drawn:ink>100,pixels:[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('')};},[...bytes]);
      assert.equal(image.drawn,true);
    }
    assert.ok(image.width>0&&image.height>0);exports.push({format,name,image});
    if(await dialog.isVisible())await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  }
  return {imported:true,edited:43,collapsed:true,expanded:true,exports};
}
