import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const documentSites=[
  {id:'pdfjs',url:'https://mozilla.github.io/pdf.js/web/viewer.html',editor:true,timeout:90000},
  {id:'cyberchef',url:'https://gchq.github.io/CyberChef/',editor:true,timeout:90000},
  {id:'cyberchef-hash',url:'https://gchq.github.io/CyberChef/',editor:true,timeout:90000}
];
export async function interactDocumentTool(page,proxy,site,{surface,read,wait}){
  if(site.id==='pdfjs'){
    await wait(page,proxy,`document.querySelector(".page[data-page-number='1'] .textLayer")?.textContent.includes("Trace-based")`);
    await surface.locator('#pageNumber').fill('2');await surface.locator('#pageNumber').press('Enter');
    await wait(page,proxy,`document.querySelector(".page[data-page-number='2'] canvas")?.width>0&&document.querySelector("#pageNumber").value==="2"`);
    await surface.locator('#scaleSelect').selectOption('1.5');
    await surface.locator('#viewFindButton').click();await surface.locator('#findInput').fill('JavaScript');await surface.locator('#findInput').press('Enter');
    await wait(page,proxy,'document.querySelector("#findResultsCount")?.textContent.includes("of")');
    const result=await read(page,proxy,'({pages:Number(document.querySelector("#pageNumber").max),zoom:document.querySelector("#scaleSelect").value,found:/of/.test(document.querySelector("#findResultsCount").textContent),rendered:!!document.querySelector(".page canvas")?.width})');
    assert.deepEqual(result,{pages:14,zoom:'1.5',found:true,rendered:true});
    const pending=page.waitForEvent('download');await surface.getByRole('button',{name:'Save',exact:true}).click();const download=await pending;
    assert.equal(await download.failure(),null);const chunks=[];for await(const chunk of await download.createReadStream())chunks.push(chunk);const bytes=Buffer.concat(chunks);
    assert.equal(bytes.subarray(0,5).toString(),'%PDF-');assert.ok(bytes.length>100000);
    return {...result,download:download.suggestedFilename(),pdf:true,sha256:createHash('sha256').update(bytes).digest('hex')};
  }
  // CyberChef restores URL state at the end of startup. Its editor can be
  // visible earlier; typing before this overlay is removed loses that input.
  await surface.locator('#loader-wrapper').waitFor({state:'detached',timeout:60000});
  await surface.locator('#input-text [contenteditable=true]').fill('c2FuZHN0b25l');
  await surface.locator('#search').fill('From Base64');await surface.locator('#search').press('Enter');
  await surface.locator('li.operation:visible').filter({hasText:/^From Base64$/}).first().dblclick();
  await wait(page,proxy,'document.querySelector("#output-text .cm-content")?.textContent.includes("sandstone")');
  assert.equal(await read(page,proxy,'document.querySelector("#output-text .cm-content").textContent'),'sandstone');
  // The hashing module URL is computed after a message. The explicit hash
  // variant tests this late synchronous worker import on file hosts too.
  if(site.id==='cyberchef'&&process.env.LIVE_ISOLATED!=='1')return {decoded:'sandstone'};
  await surface.locator('#search').fill('SHA2');await surface.locator('#search').press('Enter');await surface.locator('li.operation:visible').filter({hasText:/^SHA2$/}).first().dblclick();
  const hash=createHash('sha512').update('sandstone').digest('hex');
  await wait(page,proxy,'document.querySelector("#output-text .cm-content")?.textContent==='+JSON.stringify(hash));
  await surface.locator('#input-text [contenteditable=true]').fill('cHJveHk=');
  const changed=createHash('sha512').update('proxy').digest('hex');
  await wait(page,proxy,'document.querySelector("#output-text .cm-content")?.textContent==='+JSON.stringify(changed));
  return {decoded:'sandstone',sha512:hash,changed};
}
