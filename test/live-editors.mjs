import assert from 'node:assert/strict';

export async function interact_editor(page,proxy,site,{surface,read,wait}){
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
