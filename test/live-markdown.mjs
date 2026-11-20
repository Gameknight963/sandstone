import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const markdownSites=[{id:'dillinger',url:'https://dillinger.io/',editor:true,timeout:90000}];
const markdown='# Sandstone\n\nA **working** Markdown preview with [a link](https://example.com/).\n\n- [x] saved\n- [ ] pending\n\n| value | answer |\n| --- | --- |\n| caf\u00e9 | 42 |\n\n```js\nconst answer = 42;\n```\n\nUnicode: caf\u00e9 \u20ac\n';
const preview='Array.from(document.querySelectorAll("h1")).some(node=>node.textContent==="Sandstone")&&Array.from(document.querySelectorAll("strong")).some(node=>node.textContent==="working")&&Array.from(document.querySelectorAll("pre code")).some(node=>node.textContent.includes("const answer = 42"))';

export async function interactMarkdown(page,proxy,site,{surface,read,wait}){
  await surface.locator('.monaco-editor').first().waitFor();
  await surface.getByRole('button',{name:'Open settings',exact:true}).click();
  const autosave=surface.locator('#auto-save');if(await autosave.getAttribute('aria-checked')!=='true')await autosave.click();
  await surface.getByRole('button',{name:'Close settings',exact:true}).click();
  await surface.locator('.monaco-editor').first().click({position:{x:80,y:40}});
  await page.keyboard.press('Control+a');await page.keyboard.insertText(markdown);await wait(page,proxy,preview);
  await surface.getByRole('button',{name:'Save Session',exact:true}).click();
  const saved='Object.values(localStorage).some(value=>value.includes("# Sandstone")&&value.includes("const answer = 42"))';
  await wait(page,proxy,saved);
  if(proxy){
    const previous=await page.evaluate(()=>main_frame.navigation_id);await page.evaluate(()=>main_frame.eval_js('setTimeout(()=>location.reload(),0);true'));
    await page.waitForFunction(previous=>main_frame.navigation_id>previous&&!main_frame.is_navigating,previous);
  }else await page.reload({waitUntil:'domcontentloaded'});
  await surface.locator('.monaco-editor').first().waitFor();await wait(page,proxy,preview);
  const exports=[];
  for(const format of ['Markdown','HTML','Styled HTML']){
    await surface.getByRole('button',{name:'Export document',exact:true}).click();
    const pending=page.waitForEvent('download');await surface.getByRole('menuitem',{name:format,exact:true}).click();const download=await pending;
    assert.equal(await download.failure(),null);const chunks=[];for await(const chunk of await download.createReadStream())chunks.push(chunk);const bytes=Buffer.concat(chunks),text=bytes.toString('utf8');
    let content;
    if(format==='Markdown')assert.equal(text.trimEnd(),markdown.trimEnd());
    else{
      content=await page.evaluate(text=>{const doc=new DOMParser().parseFromString(text,'text/html');return {heading:doc.querySelector('h1')?.textContent,strong:doc.querySelector('strong')?.textContent,code:doc.querySelector('pre code')?.textContent.trim(),link:doc.querySelector('a[href="https://example.com/"]')?.getAttribute('href'),checks:[...doc.querySelectorAll('li input[type=checkbox]')].map(node=>node.checked),unicode:doc.body.textContent.includes('café €')};},text);
      assert.deepEqual(content,{heading:'Sandstone',strong:'working',code:'const answer = 42;',link:'https://example.com/',checks:[true,false],unicode:true});
    }
    const name=download.suggestedFilename();assert.ok(name.endsWith(format==='Markdown'?'.md':'.html'),name);
    exports.push({format,name,...(content?{content}:{sha256:createHash('sha256').update(bytes).digest('hex')})});
  }
  return {edited:true,preview:true,saved:true,reloaded:true,exports};
}
