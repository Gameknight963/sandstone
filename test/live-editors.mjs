import assert from 'node:assert/strict';

export async function interact_editor(page,proxy,site,{surface,read,wait}){
  if(site.id==='photopea'){
    await surface.getByRole('button',{name:'Start using Photopea',exact:true}).first().click();
    await surface.getByText('New Project',{exact:true}).click();
    await surface.getByLabel('Name',{exact:true}).fill('Sandstone');
    await surface.getByLabel('Width',{exact:true}).fill('128');await surface.getByLabel('Height',{exact:true}).fill('128');
    await surface.getByText('Create',{exact:true}).click();
    await surface.getByTitle('Brush Tool (B)',{exact:true}).click();
    const dimensions=await read(page,proxy,'Array.from(document.querySelectorAll("canvas"),canvas=>({width:canvas.width,height:canvas.height}))');
    const index=dimensions.reduce((best,size,index)=>size.width*size.height>dimensions[best].width*dimensions[best].height?index:best,0);
    const canvas=surface.locator('canvas').nth(index),box=await canvas.boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
    const snapshot=async()=>{
      // Compare document pixels without clipping the browser's iframe capture.
      const png=await page.screenshot();
      const pixels=await page.evaluate(async({bytes,x,y})=>{
        const image=await createImageBitmap(new Blob([Uint8Array.from(bytes)],{type:'image/png'}));
        const crop=new OffscreenCanvas(96,64),context=crop.getContext('2d');
        context.drawImage(image,x-48,y-32,96,64,0,0,96,64);image.close();
        return Array.from(context.getImageData(0,0,96,64).data);
      },{bytes:[...png],x,y});
      return Buffer.from(pixels);
    };
    await page.mouse.move(box.x+5,box.y+5);const before=await snapshot();
    await page.mouse.move(x-25,y);await page.mouse.down();await page.mouse.move(x+25,y,{steps:8});await page.mouse.up();await page.mouse.move(box.x+5,box.y+5);
    const modified='document.body.innerText.includes("Sandstone.psd *")';
    await wait(page,proxy,modified);const drawn=await snapshot();assert.notDeepEqual(drawn,before,'Photopea brush did not change the document pixels');
    await page.keyboard.press('Control+z');await wait(page,proxy,'!('+modified+')');assert.deepEqual(await snapshot(),before,'Photopea undo did not restore the blank pixels');
    await page.keyboard.press('Control+Shift+z');await wait(page,proxy,modified);assert.deepEqual(await snapshot(),drawn,'Photopea redo did not restore the brush pixels');
    return {created:true,drawn:true,undo:true,redo:true};
  }
  if(site.id==='desmos'){
    await surface.locator('.dcg-mq-editable-field').first().click();
    await page.keyboard.type('y=x^2');await page.keyboard.press('Enter');
    const expressions='Calc.getExpressions().map(expression=>expression.latex||"")';
    await wait(page,proxy,expressions+'.includes("y=x^{2}")');
    const plotted='(()=>{const canvas=document.querySelector("canvas.dcg-graph-inner");if(!canvas)return false;const data=canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height).data;for(let index=0;index<data.length;index+=4)if(data[index]>150&&data[index+1]<130&&data[index+2]<130&&data[index+3]>200)return true;return false;})()';
    await wait(page,proxy,plotted);const after=await read(page,proxy,expressions),serialized=JSON.stringify(JSON.stringify(after));
    await surface.getByRole('button',{name:'Undo',exact:true}).click();await wait(page,proxy,'JSON.stringify('+expressions+')!=='+serialized);
    await surface.getByRole('button',{name:'Redo',exact:true}).click();await wait(page,proxy,'JSON.stringify('+expressions+')==='+serialized);await wait(page,proxy,plotted);
    return {expressions:after.filter(Boolean),plotted:true,undo:true,redo:true};
  }
  if(site.id==='jspaint'){
    await surface.locator('canvas.main-canvas').waitFor();
    await surface.locator('.tool[title="Pencil"]').click();
    const ink='(()=>{const canvas=document.querySelector("canvas.main-canvas"),data=canvas.getContext("2d").getImageData(10,10,110,110).data;let count=0;for(let index=0;index<data.length;index+=4)if(data[index+3]&&Math.min(data[index],data[index+1],data[index+2])<128)count++;return count;})()';
    const before=await read(page,proxy,ink),canvas=surface.locator('canvas.main-canvas'),box=await canvas.boundingBox();
    const size=await read(page,proxy,'({width:document.querySelector("canvas.main-canvas").width,height:document.querySelector("canvas.main-canvas").height})');
    const point=(x,y)=>({x:box.x+x*box.width/size.width,y:box.y+y*box.height/size.height});
    const start=point(30,30),end=point(90,70);
    await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:12});await page.mouse.up();
    await wait(page,proxy,ink+'>'+before);const drawn=await read(page,proxy,ink);
    await page.keyboard.press('Control+z');await wait(page,proxy,ink+'==='+before);
    await page.keyboard.press('Control+y');await wait(page,proxy,ink+'==='+drawn);
    return {drawn:true,undo:true,redo:true};
  }
  if(site.id==='mermaid'){
    await surface.locator('.monaco-editor').first().waitFor();
    const stay=surface.getByText('Stay in mermaid.live',{exact:true});
    try{await stay.waitFor({state:'visible',timeout:4000});await stay.click();}catch(error){if(error.name!=='TimeoutError')throw error;}
    await surface.locator('[data-dialog-overlay]').waitFor({state:'hidden'});
    await surface.locator('.monaco-editor').first().click({position:{x:80,y:40}});
    await page.keyboard.press('Control+a');await page.keyboard.insertText('flowchart LR\n A[Sandstone] --> B[Working]');
    const rendered='Array.from(document.querySelectorAll("svg")).some(svg=>svg.textContent.includes("Sandstone")&&svg.textContent.includes("Working")&&svg.querySelectorAll(".node").length===2)';
    await wait(page,proxy,rendered);
    return {edited:true,preview:true,nodes:2};
  }
  if(site.id==='diagrams'){
    const item=surface.locator('.geSidebarContainer .geItem').first();await item.waitFor();
    const rectangles='document.querySelectorAll(".geDiagramContainer svg rect").length';
    const before=await read(page,proxy,rectangles);await item.click();await wait(page,proxy,rectangles+'>'+before);
    await page.keyboard.press('Control+z');await wait(page,proxy,rectangles+'==='+before);
    await page.keyboard.press('Control+y');await wait(page,proxy,rectangles+'>'+before);
    return {inserted:true,undo:true,redo:true};
  }
  assert.fail('Unknown editor: '+site.id);
}
