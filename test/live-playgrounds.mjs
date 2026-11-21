import assert from 'node:assert/strict';
import LZString from 'lz-string';

export const playgroundSites=[{id:'flems',url:'https://flems.io/',editor:true}];

export async function interactPlayground(page,proxy,site,{surface,read,wait}){
  const html='<h1 id="marker">Sandstone preview</h1><button id="increment">Add</button><output id="value">0</output>';
  const javascript='let count=0;document.getElementById("increment").onclick=()=>{document.getElementById("value").textContent=String(++count);};';
  const css='#marker{color:rgb(17,34,51)}';
  // The icon controls expose their labels in child tooltips.
  await surface.getByText(/^disable auto reload$/i).locator('..').click();
  async function edit(name,source){
    await surface.getByText(name,{exact:true}).click();
    const mode=name==='.html'?'htmlmixed':name==='.js'?'javascript':'css';
    await wait(page,proxy,'document.querySelector(".CodeMirror")?.CodeMirror.getMode().name==='+JSON.stringify(mode));
    await surface.locator('.CodeMirror').click();
    await page.keyboard.press('Control+a');await page.keyboard.insertText(source);
    await wait(page,proxy,'document.querySelector(".CodeMirror")?.CodeMirror.getValue()==='+JSON.stringify(source));
  }
  await edit('.html',html);
  await edit('.js',javascript);
  await edit('.css',css);
  async function saved(){
    const deadline=Date.now()+8000;
    let state;
    while(Date.now()<deadline){
      const hash=await read(page,proxy,'location.hash');
      try{state=JSON.parse(LZString.decompressFromEncodedURIComponent(hash.slice(3)));}catch{}
      if(Object.entries({'.html':html,'.js':javascript,'.css':css}).every(([name,content])=>state?.files?.some(file=>file.name===name&&file.content===content)))return;
      await page.waitForTimeout(50);
    }
    throw new Error('Flems did not save all edited files in its URL: '+JSON.stringify(state));
  }
  await surface.getByText(/^refresh$/i).locator('..').click();
  const preview=surface.frameLocator('iframe');
  async function ready(){
    const deadline=Date.now()+8000;
    while(Date.now()<deadline){
      try{
        await preview.locator('#marker').waitFor({timeout:1000});
        if(await preview.locator('#marker').evaluate(node=>getComputedStyle(node).color==='rgb(17, 34, 51)'&&typeof document.getElementById('increment')?.onclick==='function'))return;
      }catch{}
      await page.waitForTimeout(50);
    }
    throw new Error('Flems did not apply the edited HTML, JavaScript and CSS to its preview');
  }
  await ready();
  await preview.getByRole('button',{name:'Add',exact:true}).click();
  await preview.getByRole('button',{name:'Add',exact:true}).click();
  await preview.locator('#value').filter({hasText:/^2$/}).waitFor();
  assert.equal(await preview.locator('#marker').evaluate(node=>getComputedStyle(node).color),'rgb(17, 34, 51)');
  // Flems publishes the edited URL after the preview finishes loading.
  await saved();
  assert.equal(await read(page,proxy,'document.querySelector(".CodeMirror").CodeMirror.getValue()'),css);
  if(proxy){
    const navigation=await page.evaluate(()=>main_frame.navigation_id);
    await page.evaluate(()=>main_frame.eval_js('setTimeout(()=>location.reload(),0);true'));
    await page.waitForFunction(id=>main_frame.navigation_id>id&&!main_frame.is_navigating,navigation);
  }else await page.reload({waitUntil:'domcontentloaded'});
  await ready();
  await preview.getByRole('button',{name:'Add',exact:true}).click();
  await preview.locator('#value').filter({hasText:/^1$/}).waitFor();
  assert.equal(await preview.locator('#marker').innerText(),'Sandstone preview');
  assert.equal(await preview.locator('#marker').evaluate(node=>getComputedStyle(node).color),'rgb(17, 34, 51)');
  return {html:true,javascript:true,css:true,interactive:true,reloaded:true};
}
