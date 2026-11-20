import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {verifyWorkerLoaders} from './worker-loaders.playwright.mjs';
import {verifyPromiseWorkerLoaders} from './worker-promise-loaders.playwright.mjs';
import {verifyWorkerImportAliases} from './worker-import-aliases.playwright.mjs';

export async function verifyIsolatedWorkerLoaders(page){
  const html=await readFile(new URL('../example/bundled.html',import.meta.url),'utf8');
  const server=createServer((request,response)=>{
    response.writeHead(200,{'content-type':'text/html','cross-origin-opener-policy':'same-origin','cross-origin-embedder-policy':'require-corp'});response.end(html);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const fixture=await page.context().newPage();
  try{
    await fixture.goto('http://127.0.0.1:'+server.address().port+'/host');
    assert.equal(await fixture.evaluate(()=>crossOriginIsolated),true);
    const passed=[];
    for(const verify of [verifyWorkerLoaders,verifyPromiseWorkerLoaders,verifyWorkerImportAliases])passed.push(...await verify(fixture));
    return passed.map(message=>'Isolated host: '+message);
  }finally{await fixture.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
