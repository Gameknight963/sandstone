import assert from 'node:assert/strict';

const origin='https://filesystem-native.test';
async function scenario(){
  const root=await navigator.storage.getDirectory(),dir=await root.getDirectoryHandle('folder',{create:true}),file=await dir.getFileHandle('hello.txt',{create:true});
  const result={identity:navigator.storage===navigator.storage,tag:Object.prototype.toString.call(navigator.storage),root:[root.name,root.kind,root instanceof FileSystemDirectoryHandle],file:[file.name,file.kind,file instanceof FileSystemFileHandle],permission:await file.queryPermission({mode:'readwrite'})};
  let stream=await file.createWritable();result.stream=stream instanceof WritableStream&&stream instanceof FileSystemWritableFileStream;
  await stream.write('hello');await stream.seek(8);await stream.write(new Uint8Array([9,1,2,8]).subarray(1,3));await stream.truncate(12);await stream.close();
  const snapshot=await file.getFile();result.content=[...new Uint8Array(await snapshot.arrayBuffer())];result.mime=snapshot.type;result.fileSnapshot=snapshot instanceof File;
  stream=await file.createWritable({keepExistingData:true});await stream.write({type:'write',position:0,data:'BYE'});await stream.abort();result.aborted=[...new Uint8Array(await(await file.getFile()).arrayBuffer())];
  stream=await file.createWritable();await Promise.all([stream.write('a'),stream.write('b')]);await stream.close();result.concurrent=await(await file.getFile()).text();
  result.path=await root.resolve(file);result.entries=[];for await(const [name,handle] of root)result.entries.push([name,handle.kind]);result.same=await file.isSameEntry(structuredClone(file));
  const channel=new MessageChannel();result.port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('File handle MessagePort timed out')),5000);channel.port2.onmessage=async event=>{clearTimeout(timer);try{resolve({typed:event.data instanceof FileSystemFileHandle,body:await(await event.data.getFile()).text()});}catch(error){reject(error);}};channel.port2.onmessageerror=()=>{clearTimeout(timer);reject(new Error('File handle clone failed'));};channel.port1.postMessage(file);});channel.port1.close();channel.port2.close();
  const failures=[];
  for(const run of [()=>root.getFileHandle('missing'),()=>root.getFileHandle('folder'),()=>root.getDirectoryHandle('../x'),()=>root.removeEntry('folder'),()=>file.createWritable({mode:''}),()=>file.createWritable({mode:null}),()=>file.queryPermission({mode:null})])try{await run();failures.push('none');}catch(error){failures.push(error.name);}
  result.errors=failures;result.clone=Object.prototype.toString.call(structuredClone(file));
  await root.removeEntry('folder',{recursive:true});try{await file.getFile();}catch(error){result.removed=error.name;}
  result.removedPath=await root.resolve(file);
  const again=await root.getDirectoryHandle('folder',{create:true}),replacement=await again.getFileHandle('hello.txt',{create:true});result.recreated=await file.isSameEntry(replacement);result.oldHandle=(await file.getFile()).size;
  await root.removeEntry('folder',{recursive:true});
  const empty=await root.getFileHandle('empty',{create:true}),emptyWriter=await empty.createWritable();await emptyWriter.seek(1000000000);await emptyWriter.write(new Blob([]));await emptyWriter.close();result.empty=(await empty.getFile()).size;await root.removeEntry('empty');
  const estimate=await navigator.storage.estimate();result.estimate={usage:typeof estimate.usage,quota:typeof estimate.quota,valid:estimate.quota>=estimate.usage};result.persisted=typeof await navigator.storage.persisted();
  return result;
}
export async function verifyFilesystem(page,{storageDenied=false}={}){
  const browser=page.context().browser(),nativeContext=await browser.newContext(),native=await nativeContext.newPage(),fixture=await page.context().newPage(),errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));fixture.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  const ready=async()=>{await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);};
  const prepare=async()=>fixture.evaluate(async origin=>{
    globalThis.filesystemPrevious=sandstone.network.session.fetch;
    sandstone.network.session.fetch=(url,options)=>new URL(url).hostname===new URL(origin).hostname?Promise.resolve(new Response('<!doctype html><title>Files</title><body>Files',{headers:{'content-type':'text/html'}})):filesystemPrevious(url,options);
    await main_frame.navigate_to(origin+'/page');
  },origin);
  let operation=0;
  const evaluate=source=>stage('document operation '+ ++operation,fixture.evaluate(source=>main_frame.eval_js(source),source));
  const read=async source=>JSON.parse(await evaluate('(async()=>JSON.stringify(await ('+source+')))()'));
  const stage=async(label,operation)=>{console.log(JSON.stringify({fixture:'Filesystem',stage:label}));let timer;try{return await Promise.race([operation,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('Filesystem '+label+' timed out')),15000))]);}finally{clearTimeout(timer);}};
  try{
    await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><body>Files'}));await native.goto(origin+'/page');
    const expected=await stage('native API',native.evaluate(scenario));await ready();fixture.on('request',request=>{if(/^https?:/.test(request.url())&&request.url()!==page.url())direct.push(request.url());});await prepare();
    assert.deepEqual(await stage('proxy API',read('('+scenario.toString()+')()')),expected);
    const stored=await evaluate(`(async()=>{const root=await navigator.storage.getDirectory(),file=await root.getFileHandle('persisted.txt',{create:true}),writer=await file.createWritable();await writer.write('saved');await writer.close();const open=indexedDB.open('file-handles',1);open.onupgradeneeded=()=>open.result.createObjectStore('handles');const db=await new Promise((resolve,reject)=>{open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});await new Promise((resolve,reject)=>{const tx=db.transaction('handles','readwrite');tx.objectStore('handles').put(file,'saved');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();return true;})()`);
    assert.equal(stored,true);
    // Reload a separate standalone tab so the caller's fixture transport and
    // page state survive this persistence comparison.
    await fixture.reload();await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);await prepare();
    const restored=await evaluate(`(async()=>{const root=await navigator.storage.getDirectory();try{const file=await root.getFileHandle('persisted.txt');return (await file.getFile()).text();}catch(error){if(error.name==='NotFoundError')return null;throw error;}})()`);
    assert.equal(restored,storageDenied?null:'saved');
    if(!storageDenied){
      const clone=await evaluate(`(async()=>{const request=indexedDB.open('file-handles');const db=await new Promise(resolve=>request.onsuccess=()=>resolve(request.result));const value=await new Promise(resolve=>{const get=db.transaction('handles').objectStore('handles').get('saved');get.onsuccess=()=>resolve(get.result);});db.close();return value instanceof FileSystemFileHandle&&(await value.getFile()).text();})()`);
      assert.equal(clone,'saved');
    }
    const peer=await page.context().newPage();
    try{
      peer.on('pageerror',error=>errors.push(error.message));
      await peer.goto(page.url());await peer.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
      peer.on('request',request=>{if(/^https?:/.test(request.url())&&request.url()!==page.url())direct.push(request.url());});
      await peer.evaluate(async origin=>{sandstone.network.session.fetch=async()=>new Response('<!doctype html><body>Files',{headers:{'content-type':'text/html'}});await main_frame.navigate_to(origin+'/peer');},origin);
      await evaluate(`(async()=>{const root=await navigator.storage.getDirectory(),file=await root.getFileHandle('cross-tab.txt',{create:true});globalThis.filesystemLease=await file.createWritable({mode:'exclusive'});return true;})()`);
      const attempt=`(async()=>{const root=await navigator.storage.getDirectory(),file=await root.getFileHandle('cross-tab.txt',{create:true});try{const writer=await file.createWritable({mode:'exclusive'});await writer.abort();return 'opened';}catch(error){return error.name;}})()`;
      assert.equal(await peer.evaluate(source=>main_frame.eval_js(source),attempt),storageDenied?'opened':'NoModificationAllowedError');
      await evaluate('filesystemLease.abort().then(()=>true)');
      await peer.evaluate(()=>main_frame.eval_js(`(async()=>{const root=await navigator.storage.getDirectory(),file=await root.getFileHandle('cross-tab.txt'),writer=await file.createWritable();await writer.write('shared');await writer.close();return true;})()`));
      assert.equal(await evaluate(`(async()=>{const root=await navigator.storage.getDirectory(),file=await root.getFileHandle('cross-tab.txt');return (await file.getFile()).text();})()`),storageDenied?'':'shared');
    }finally{await peer.close();await fixture.bringToFront();}
    await evaluate(`(async()=>{const root=await navigator.storage.getDirectory(),file=await root.getFileHandle('clear.txt',{create:true}),stream=await file.createWritable();await stream.write('clear me');await stream.close();return true;})()`);
    await fixture.locator('#options_button').click();await fixture.locator('#site_data_details > summary').click();
    const before=await fixture.evaluate(()=>main_frame.navigation_id);
    const row=fixture.locator('.site_data_row').filter({hasText:'filesystem-native.test'});await row.getByRole('button',{name:'Clear files',exact:true}).click();
    await fixture.waitForFunction(id=>main_frame.navigation_id>id&&!main_frame.is_navigating,before);
    assert.deepEqual(await read('(async()=>{const root=await navigator.storage.getDirectory(),names=[];for await(const name of root.keys())names.push(name);return names;})()'),[]);
    if(!storageDenied)assert.equal(await read('(async()=>{const estimate=await navigator.storage.estimate();return estimate.usage>0&&estimate.usageDetails.indexedDB>0;})()'),true,'Clearing files must not hide the retained IndexedDB data from estimates');
    await fixture.evaluate(()=>main_frame.navigate_to('http://filesystem-native.test/page'));
    assert.deepEqual(await read('({storage:typeof navigator.storage,handle:typeof FileSystemHandle,manager:typeof StorageManager})'),{storage:'undefined',handle:'undefined',manager:'undefined'});
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Origin-private files match native directories, binary streams, abort and concurrent writes','File handles retain identity through structuredClone and MessagePorts','Files and IndexedDB-stored handles survive standalone reloads when storage is available','Independent standalone tabs coordinate durable files and writer locks while memory sessions stay separate','Per-site file clearing removes stored data without affecting the host URL'];
  }finally{await fixture.close();await nativeContext.close();await page.bringToFront();}
}
