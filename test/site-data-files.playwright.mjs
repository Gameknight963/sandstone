import assert from 'node:assert/strict';

export async function verifySiteFileClearing(page){
  const fixture=await page.context().newPage(),errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));
  const origins=['https://files-control.test','https://files-control.test:8443','https://other-files-control.test','https://child.files-control.test'];
  const read=source=>fixture.evaluate(source=>main_frame.eval_js('(async()=>JSON.stringify(await ('+source+')))()'),source).then(JSON.parse);
  const row=host=>fixture.locator('.site_data_row').filter({hasText:new RegExp('^'+host.replaceAll('.','\\.')+':')});
  try{
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
    await fixture.evaluate(()=>{main_frame.on_load=()=>{};sandstone.network.session.fetch=async()=>new Response('<!doctype html><body>File controls',{headers:{'content-type':'text/html','cache-control':'no-store'}});});
    await fixture.evaluate(()=>sandstone.controller.site_data.setCookie('https://files-control.test/','parent_cookie=retained; Domain=files-control.test; Path=/'));
    for(const [index,origin] of origins.entries()){
      await fixture.evaluate(url=>main_frame.navigate_to(url),origin+'/page');
      await read('(async()=>{localStorage.setItem("retained","yes");const root=await navigator.storage.getDirectory();globalThis.savedFile=await root.getFileHandle("saved.txt",{create:true});const writer=await savedFile.createWritable();await writer.write('+JSON.stringify('file-'+index)+');await writer.close();return true;})()');
    }
    await read('(async()=>{globalThis.pendingWriter=await savedFile.createWritable({keepExistingData:true});await pendingWriter.seek(6);return true;})()');
    const token=await fixture.evaluate(()=>main_frame.document_context);
    await fixture.getByRole('button',{name:'Options',exact:true}).click();await fixture.locator('#site_data_details').evaluate(element=>element.open=true);
    await row('files-control.test').getByRole('button',{name:'Clear files',exact:true}).waitFor();
    await row('files-control.test').getByRole('button',{name:'Clear files',exact:true}).click();
    await fixture.waitForFunction(()=>sandstone.controller.site_data.list().find(site=>site.hostname==='files-control.test')?.files===undefined);
    assert.equal(await fixture.evaluate(()=>main_frame.document_context),token,'Clearing parent files must not reload a distinct child hostname');
    assert.equal(await read('(async()=>{await pendingWriter.write("-retained");await pendingWriter.close();return await(await savedFile.getFile()).text();})()'),'file-3-retained');
    await fixture.locator('#close_options_button').click();
    for(const [index,origin] of origins.entries()){
      await fixture.evaluate(url=>main_frame.navigate_to(url),origin+'/page');
      assert.deepEqual(await read('(async()=>{const root=await navigator.storage.getDirectory();return {names:await Array.fromAsync(root.keys()),local:localStorage.getItem("retained")};})()'),{names:index<2?[]:['saved.txt'],local:'yes'});
      if(index>=2)assert.equal(await read('(async()=>{const root=await navigator.storage.getDirectory();return await(await(await root.getFileHandle("saved.txt")).getFile()).text();})()'),index===3?'file-3-retained':'file-'+index);
    }
    await fixture.getByRole('button',{name:'Options',exact:true}).click();await fixture.locator('#site_data_details').evaluate(element=>element.open=true);
    const childToken=await fixture.evaluate(()=>main_frame.document_context);
    await row('child.files-control.test').getByRole('button',{name:'Clear files',exact:true}).click();
    await fixture.waitForFunction(previous=>main_frame.document_context!==previous&&!main_frame.is_navigating,childToken);
    assert.deepEqual(await read('(async()=>{const root=await navigator.storage.getDirectory();return await Array.fromAsync(root.keys());})()'),[]);
    assert.equal((await read('document.cookie')).includes('parent_cookie=retained'),true);
    const cookieToken=await fixture.evaluate(()=>main_frame.document_context);
    await row('files-control.test').getByRole('button',{name:'Clear cookies',exact:true}).click();
    await fixture.waitForFunction(previous=>main_frame.document_context!==previous&&!main_frame.is_navigating,cookieToken);
    assert.deepEqual(await read('({cookie:document.cookie,local:localStorage.getItem("retained")})'),{cookie:'',local:'yes'});
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Per-site Clear files removes every port for the selected hostname while preserving subdomain and unrelated files','Clearing a parent hostname preserves a child document and its open file writer','Clearing the current hostname reloads it with an empty file system and retains local storage','Clearing parent-domain cookies still reloads child pages and preserves local storage'];
  }finally{await fixture.close();await page.bringToFront();}
}
