import assert from 'node:assert/strict';

export const workbenchSites=[{id:'vscode',url:'https://vscode.dev/',editor:true,timeout:90000}];
const sample={answer:42,items:[1,2,3]};
const text='Array.from(document.querySelectorAll(".monaco-editor .view-lines")).at(-1)?.innerText.replace(/\\u00a0/g," ")||""';

export async function interactWorkbench(page,proxy,{surface,read,wait}){
  await wait(page,proxy,'!!document.querySelector(".monaco-workbench")');
  const input=surface.locator('.quick-input-box input');
  const choose=label=>surface.locator('.quick-input-list .label-name').filter({hasText:new RegExp('^'+label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')}).click();
  async function command(label){await page.keyboard.press('Control+Shift+p');await input.fill('>'+label);await choose(label);}
  await command('File: New Untitled Text File');
  await wait(page,proxy,'!!document.querySelector(".monaco-editor[data-uri^=untitled]")');
  await command('Change Language Mode');await input.fill('JSON');await choose('JSON');
  await page.keyboard.press('Escape');await page.mouse.move(0,0);
  const compact=JSON.stringify(sample);await page.keyboard.type(compact);
  await wait(page,proxy,'('+text+')==='+JSON.stringify(compact));
  const formattedExpression='('+text+').includes("\\n")',missing='document.body.innerText.includes("There is no formatter")';
  let ready=false;
  // VS Code can show its no-provider dialog before the built-in JSON
  // extension finishes starting. Retry that explicit state, not an active
  // formatting request, so slow worker startup is still exercised.
  const expires=Date.now()+60000;
  while(Date.now()<expires){
    await page.keyboard.press('Shift+Alt+f');
    await wait(page,proxy,formattedExpression+'||'+missing);
    if(await read(page,proxy,formattedExpression)){ready=true;break;}
    await surface.getByRole('button',{name:'Cancel',exact:true}).click();await page.waitForTimeout(300);
  }
  if(!ready){
    let details;
    try{await command('Developer: Show Running Extensions');await wait(page,proxy,'!!document.querySelector(".runtime-extensions-editor")');details=await read(page,proxy,'document.body.innerText.slice(-7000)');}catch(error){details=error.message;}
    throw new Error('VS Code JSON formatter never became available: '+details);
  }
  const formatted=await read(page,proxy,text);assert.deepEqual(JSON.parse(formatted),sample,'VS Code formatter changed the JSON values');
  await page.keyboard.press('Control+z');await wait(page,proxy,'('+text+')==='+JSON.stringify(compact));
  await page.keyboard.press('Control+Shift+z');await wait(page,proxy,'('+text+')==='+JSON.stringify(formatted));
  // Untitled labels update on a debounce. The former compact first line must
  // no longer name the formatted document when the runner compares titles.
  await wait(page,proxy,'!document.title.includes('+JSON.stringify(compact)+')');
  return {created:true,edited:true,formatted:true,undo:true,redo:true,value:JSON.parse(formatted)};
}
