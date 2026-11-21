import {listen_browser_server} from './browser-server.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';

// Exercise the unmodified SQLite WASM distribution and its real OPFS backends,
// including the nested-worker paths, rather than substituting a JavaScript VFS.
const workerSource=`import init from '/sqlite/index.mjs';
onmessage=async event=>{try{
  const sqlite=await init({print:()=>{},printErr:console.warn});
  const vfs=event.data.vfs,pool=vfs==='opfs-sahpool'?await sqlite.installOpfsSAHPoolVfs({initialCapacity:4,verbosity:0}):null;
  if(!sqlite.capi.sqlite3_vfs_find(vfs))throw new Error('SQLite VFS was not installed: '+vfs);
  const db=new sqlite.oo1.DB('/records.sqlite3','c',vfs);
  try{
    db.exec('CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY, name TEXT, payload BLOB)');
    const before=db.selectValue('SELECT count(*) FROM records');
    if(event.data.action==='write'){
      db.exec('BEGIN');
      for(let i=0;i<8;i++)db.exec({sql:'INSERT INTO records(name,payload) VALUES(?,?)',bind:['row-'+i,new Uint8Array(4096).fill(i)]});
      db.exec('COMMIT');
      db.exec("BEGIN; INSERT INTO records(name) VALUES('rollback'); ROLLBACK");
    }
    const result={before,count:db.selectValue('SELECT count(*) FROM records'),bytes:db.selectValue('SELECT sum(length(payload)) FROM records'),lastByte:db.selectValue('SELECT hex(substr(payload,4096,1)) FROM records ORDER BY id DESC LIMIT 1'),rollback:db.selectValue("SELECT count(*) FROM records WHERE name='rollback'"),integrity:db.selectValue('PRAGMA integrity_check')};
    db.close();pool?.pauseVfs();postMessage({result});
  }catch(error){db.close();pool?.pauseVfs();throw error;}
}catch(error){postMessage({error:error.stack||String(error)});}};`;

const workerRun=(action,vfs)=>`new Promise((resolve,reject)=>{
  const worker=new Worker('/worker.mjs',{type:'module'});
  const finish=()=>{clearTimeout(timer);worker.terminate();};
  const timer=setTimeout(()=>{finish();reject(new Error('SQLite worker timed out'));},15000);
  worker.onerror=event=>{finish();reject(new Error(event.message));};
  worker.onmessage=event=>{finish();if(event.data.error)reject(new Error(event.data.error));else resolve(event.data.result);};
  worker.postMessage(${JSON.stringify({action,vfs})});
})`;

const frameHTML=`<!doctype html><script>
addEventListener('message',async event=>{
  if(event.source!==parent||!event.data?.sqliteSource)return;
  try{const result=await eval(event.data.sqliteSource);parent.postMessage({sqliteResult:result},'*');}
  catch(error){parent.postMessage({sqliteError:error.message},'*');}
});parent.postMessage({sqliteReady:true},'*');
</script>`;
const frameRun=(action,vfs)=>`new Promise((resolve,reject)=>{
  const frame=document.createElement('iframe');
  const finish=()=>{clearTimeout(timer);removeEventListener('message',receive);frame.remove();};
  const receive=event=>{
    if(event.source!==frame.contentWindow)return;
    if(event.data?.sqliteReady)frame.contentWindow.postMessage({sqliteSource:${JSON.stringify(workerRun(action,vfs))}},'*');
    else if(event.data?.sqliteResult){finish();resolve(event.data.sqliteResult);}
    else if(event.data?.sqliteError){finish();reject(new Error(event.data.sqliteError));}
  };
  const timer=setTimeout(()=>{finish();reject(new Error('SQLite iframe timed out'));},20000);
  addEventListener('message',receive);frame.src='/database-frame.html';document.body.append(frame);
})`;

export async function verifySQLiteFiles(page,{storageDenied=false,vfs='opfs-sahpool',nestedFrame=false}={}){
  const html=await readFile(new URL('../example/bundled.html',import.meta.url));
  const files=new Map([['/worker.mjs',{body:Buffer.from(workerSource),type:'text/javascript'}]]);
  files.set('/database-frame.html',{body:Buffer.from(frameHTML),type:'text/html'});
  for(const name of ['index.mjs','sqlite3.wasm','sqlite3-opfs-async-proxy.js']){
    files.set('/sqlite/'+name,{body:await readFile(new URL('../node_modules/@sqlite.org/sqlite-wasm/dist/'+name,import.meta.url)),type:name.endsWith('.wasm')?'application/wasm':'text/javascript'});
  }
  const server=createServer((request,response)=>{
    response.setHeader('cross-origin-opener-policy','same-origin');
    response.setHeader('cross-origin-embedder-policy','require-corp');
    const file=files.get(new URL(request.url,'http://localhost').pathname);
    response.setHeader('content-type',file?.type||'text/html');
    response.end(file?.body||(request.url==='/host'?html:'<!doctype html><body>SQLite file fixture'));
  });
  await listen_browser_server(server);
  const host='http://127.0.0.1:'+server.address().port+'/host';
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage(),fixture=await page.context().newPage();
  const errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));
  fixture.on('console',message=>{
    if(message.type()==='error'&&message.text()!=='Permissions policy violation: unload is not allowed in this document.')errors.push(message.text());
  });
  fixture.on('request',request=>{if(/^https?:/.test(request.url())&&request.url()!==host)direct.push(request.url());});
  const run=action=>(nestedFrame?frameRun:workerRun)(action,vfs);
  const read=action=>fixture.evaluate(source=>main_frame.eval_js('(async()=>JSON.stringify(await ('+source+')))()'),run(action)).then(JSON.parse);
  try{
    await native.goto(host.replace('/host','/native'));
    const expectedWrite=await native.evaluate(source=>eval(source),run('write'));
    assert.deepEqual(expectedWrite,{before:0,count:8,bytes:32768,lastByte:'07',rollback:0,integrity:'ok'});
    const expectedRead=await native.evaluate(source=>eval(source),run('read'));
    assert.deepEqual(expectedRead,{...expectedWrite,before:8});
    await native.reload();
    assert.deepEqual(await native.evaluate(source=>eval(source),run('read')),expectedRead);

    async function navigate(){
      await fixture.goto(host);
      await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
      await fixture.evaluate(async entries=>{
        const assets=new Map(entries.map(([name,file])=>[name,{...file,body:Uint8Array.from(atob(file.body),character=>character.charCodeAt(0))}]));
        sandstone.network.session.fetch=async url=>{
          const file=assets.get(new URL(url).pathname);
          return new Response(file?.body||'<!doctype html><body>SQLite file fixture',{headers:{'content-type':file?.type||'text/html'}});
        };
        await main_frame.navigate_to('https://sqlite-filesystem.test/page');
      },[...files].map(([name,file])=>[name,{type:file.type,body:file.body.toString('base64')}]));
    }
    await navigate();
    assert.deepEqual(await read('write'),expectedWrite);
    assert.deepEqual(await read('read'),expectedRead,'A new worker must reopen the committed database');
    await navigate();
    // selectValue returns undefined for no rows; JSON messaging omits that field.
    const empty={before:0,count:0,bytes:null,rollback:0,integrity:'ok'};
    assert.deepEqual(await read('read'),storageDenied?empty:expectedRead,'Database reload persistence must match the storage capability');
    if(storageDenied)assert.deepEqual(await read('write'),expectedWrite);

    await fixture.locator('#options_button').click();
    await fixture.locator('#site_data_details > summary').click();
    const navigation=await fixture.evaluate(()=>main_frame.navigation_id);
    await fixture.locator('.site_data_row').filter({hasText:'sqlite-filesystem.test'}).getByRole('button',{name:'Clear files',exact:true}).click();
    await fixture.waitForFunction(id=>main_frame.navigation_id>id&&!main_frame.is_navigating,navigation);
    assert.deepEqual(await read('read'),empty,'Per-site file clearing must remove the SQLite database');
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Official SQLite WASM '+vfs+(nestedFrame?' inside a child iframe':'')+' commits binary rows, rolls back transactions and passes integrity checks','SQLite '+vfs+' databases reopen in new workers, persist according to storage availability and support per-site file clearing'];
  }finally{
    await fixture.close();await nativeContext.close();
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await page.bringToFront();
  }
}
