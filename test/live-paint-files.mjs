import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const paintFileSites=[{id:'jspaint-files',url:'https://jspaint.app/',editor:true,timeout:60000}];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function interactPaintFiles(page,proxy,{surface,read,wait}){
  await surface.locator('canvas.main-canvas').waitFor();
  const png=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=48;
    const context=canvas.getContext('2d');context.fillStyle='#2468ac';context.fillRect(0,0,32,48);
    context.fillStyle='#e0a040';context.fillRect(32,0,32,48);return canvas.toDataURL('image/png').split(',')[1];
  });
  const pixels='Array.from(document.querySelector("canvas.main-canvas").getContext("2d").getImageData(0,0,64,48).data)';
  async function open(name,mimeType,buffer,pixel){
    await surface.getByRole('menuitem',{name:/^File/}).click();
    const pending=page.waitForEvent('filechooser');await surface.getByRole('menuitem',{name:/^Open\b/}).click();
    await(await pending).setFiles({name,mimeType,buffer});
    await wait(page,proxy,'(()=>{const canvas=document.querySelector("canvas.main-canvas");return canvas?.width===64&&canvas?.height===48&&Array.from(canvas.getContext("2d").getImageData(0,0,1,1).data).join(",")==='+JSON.stringify(pixel.join(','))+';})()');
  }
  await open('sandstone-source.png','image/png',Buffer.from(png,'base64'),[36,104,172,255]);
  const initial=Buffer.from(await read(page,proxy,pixels));assert.deepEqual([...initial.subarray(0,4)],[36,104,172,255]);
  await surface.getByRole('menuitem',{name:/^Image/}).click();await surface.getByRole('menuitem',{name:/^Invert Colors/}).click();
  await wait(page,proxy,'document.querySelector("canvas.main-canvas").getContext("2d").getImageData(0,0,1,1).data[0]===219');
  const painted=Buffer.from(await read(page,proxy,pixels));assert.deepEqual(painted,initial.map((value,index)=>index%4===3?value:255-value),'Invert Colors did not edit the opened image');
  const expectedPixels=hash(painted),exports=[];
  for(const [extension,mimeType,label,signature] of [['png','image/png','PNG (*.png)','89504e470d0a1a0a'],['bmp','image/bmp','24-bit Bitmap (*.bmp;*.dib)','424d']]){
    await surface.getByRole('menuitem',{name:/^File/}).click();await surface.getByRole('menuitem',{name:/^Save As/}).click();
    const name='sandstone-roundtrip.'+extension;
    await surface.locator('input.file-name').fill(name);await surface.getByRole('combobox').selectOption({label});
    const pending=page.waitForEvent('download');await surface.getByRole('button',{name:'Save',exact:true}).click();
    const download=await pending;assert.equal(await download.failure(),null);assert.equal(download.suggestedFilename(),name);
    const chunks=[];for await(const chunk of await download.createReadStream())chunks.push(chunk);const bytes=Buffer.concat(chunks);
    assert.equal(bytes.subarray(0,signature.length/2).toString('hex'),signature);
    const decoded=await page.evaluate(async({bytes,mimeType})=>{
      const image=await createImageBitmap(new Blob([Uint8Array.from(bytes)],{type:mimeType}));
      const canvas=new OffscreenCanvas(image.width,image.height),context=canvas.getContext('2d');context.drawImage(image,0,0);image.close();
      return {width:canvas.width,height:canvas.height,pixels:Array.from(context.getImageData(0,0,canvas.width,canvas.height).data)};
    },{bytes:[...bytes],mimeType});
    assert.equal(decoded.width,64);assert.equal(decoded.height,48);assert.equal(hash(Buffer.from(decoded.pixels)),expectedPixels,'Exported pixels differ from the edited document');
    // Reset the document before reopening, so unchanged pixels cannot make a
    // missing file-input event or failed decode look like a successful import.
    await surface.getByRole('menuitem',{name:/^File/}).click();await surface.getByRole('menuitem',{name:/^New\b/}).click();
    await wait(page,proxy,'Array.from(document.querySelector("canvas.main-canvas").getContext("2d").getImageData(0,0,1,1).data).join(",")==="255,255,255,255"');
    await open(name,mimeType,bytes,[...painted.subarray(0,4)]);
    assert.equal(hash(Buffer.from(await read(page,proxy,pixels))),expectedPixels,'Reopening the download changed the document');
    exports.push({name,width:decoded.width,height:decoded.height,pixels:expectedPixels,reopened:true});
  }
  return {opened:true,inverted:true,exports};
}
