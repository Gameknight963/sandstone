import assert from 'node:assert/strict';
import {inflateRawSync} from 'node:zlib';

// The Foundation's published GUI exercises the editor without login or the
// main site's availability checks. Keep the editing/export assertions native.
export const scratchSites=[{id:'scratch',url:'https://scratchfoundation.github.io/scratch-gui/',editor:true,timeout:90000}];

function projectJSON(bytes){
  let end=bytes.length-22;
  while(end>=0&&bytes.readUInt32LE(end)!==0x06054b50)end--;
  assert.ok(end>=0,'Scratch download is not a ZIP');
  let offset=bytes.readUInt32LE(end+16);
  for(let index=0;index<bytes.readUInt16LE(end+10);index++){
    assert.equal(bytes.readUInt32LE(offset),0x02014b50);
    const method=bytes.readUInt16LE(offset+10),size=bytes.readUInt32LE(offset+20),nameSize=bytes.readUInt16LE(offset+28);
    const extra=bytes.readUInt16LE(offset+30),comment=bytes.readUInt16LE(offset+32),local=bytes.readUInt32LE(offset+42);
    const name=bytes.subarray(offset+46,offset+46+nameSize).toString();
    if(name==='project.json'){
      assert.equal(bytes.readUInt32LE(local),0x04034b50);
      const start=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28),body=bytes.subarray(start,start+size);
      assert.ok(method===0||method===8,'Unknown Scratch archive compression');
      return JSON.parse((method===8?inflateRawSync(body):body).toString());
    }
    offset+=46+nameSize+extra+comment;
  }
  throw new Error('Scratch archive lacks project.json');
}

export async function interactScratch(page,proxy,{surface,read,wait}){
  await surface.getByText('Costumes',{exact:true}).waitFor({timeout:60000});
  const name=surface.getByPlaceholder('Name',{exact:true}),x=surface.getByPlaceholder('x',{exact:true});
  await name.fill('Sandstone');await name.press('Enter');
  await x.fill('42');await x.press('Enter');
  await wait(page,proxy,'document.querySelector("input[placeholder=x]").value==="42"');
  const block=surface.locator('.blocklyFlyout g.blocklyDraggable').filter({hasText:/move.*steps/s}).first();
  const start=await block.boundingBox(),workspace=await surface.locator('.blocklyMainBackground').first().boundingBox();
  assert.ok(start&&workspace,'Scratch block workspace is unavailable');
  // Drag/click the block body, away from its editable numeric field.
  await page.mouse.move(start.x+12,start.y+12);await page.mouse.down();
  await page.mouse.move(workspace.x+workspace.width*.7,workspace.y+workspace.height*.35,{steps:15});await page.mouse.up();
  const placed=surface.locator('.blocklySvg > g.blocklyWorkspace > g.blocklyBlockCanvas > g.blocklyDraggable').filter({hasText:/move.*steps/s}).first();
  await page.waitForTimeout(300);await placed.click({position:{x:12,y:12}});
  await wait(page,proxy,'document.querySelector("input[placeholder=x]").value==="52"');

  await surface.getByText('File',{exact:true}).click();
  const pending=page.waitForEvent('download');await surface.getByText('Save to your computer',{exact:true}).click();
  const download=await pending;assert.equal(await download.failure(),null);assert.ok(download.suggestedFilename().endsWith('.sb3'));
  const chunks=[];for await(const chunk of await download.createReadStream())chunks.push(chunk);
  const bytes=Buffer.concat(chunks),project=projectJSON(bytes);
  const sprites=project.targets.filter(target=>!target.isStage).map(({name,x,y,costumes})=>({name,x,y,costumes:costumes.length}));
  assert.deepEqual(sprites,[{name:'Sandstone',x:52,y:0,costumes:2}]);
  assert.ok(Object.values(project.targets.find(target=>!target.isStage).blocks).some(block=>block.opcode==='motion_movesteps'));

  await name.fill('Discarded');await name.press('Enter');await x.fill('-50');await x.press('Enter');
  const onDialog=dialog=>dialog.accept();page.on('dialog',onDialog);
  try{
    await surface.getByText('File',{exact:true}).click();const chooser=page.waitForEvent('filechooser');
    await surface.getByText('Load from your computer',{exact:true}).click();
    await (await chooser).setFiles({name:'sandstone.sb3',mimeType:'application/octet-stream',buffer:bytes});
    await wait(page,proxy,'document.querySelector("input[placeholder=Name]").value==="Sandstone"&&document.querySelector("input[placeholder=x]").value==="52"');
  }finally{page.off('dialog',onDialog);}
  return {renamed:true,moved:true,executed:true,download:true,imported:true,sprites};
}
