import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const files=new Map(['libcurl.js','libcurl_full.js','libcurl.wasm'].map(name=>[name,readFileSync(new URL('../node_modules/libcurl.js/'+name,import.meta.url))]));
export function transport_fixture(request,response,url){
  if(!url.pathname.startsWith('/transport/'))return false;
  const name=url.pathname.slice('/transport/'.length),body=files.get(name);
  response.writeHead(body?200:404,{'Content-Type':name.endsWith('.wasm')?'application/wasm':'text/javascript','Cache-Control':'no-store'});
  response.end(body||'Missing transport fixture');return true;
}

export async function verify_transport_entries(context,origin,nativeHeaders){
  const results=[];
  for(const filename of ['libcurl.js','libcurl_full.js']){
    const page=await context.newPage();
    try{
      await page.goto(origin);
      const requests=[];page.on('request',request=>requests.push(request.url()));
      await page.addScriptTag({url:origin+'/transport/'+filename});
      if(filename==='libcurl.js')await page.evaluate(url=>libcurl.load_wasm(url),origin+'/transport/libcurl.wasm');
      // The bundled entry must initialize without load_wasm(), and its optional
      // URL argument must never replace the embedded WASM with a network fetch.
      await page.waitForFunction(()=>typeof libcurl!=='undefined'&&libcurl.version!==null);
      await page.evaluate(url=>libcurl.load_wasm(url),origin+'/transport/must-not-be-used.wasm');
      const actual=await page.evaluate(async origin=>{
        libcurl.set_websocket(origin.replace('http:','ws:')+'/');
        const results=[],read=async options=>results.push(await(await libcurl.fetch(origin+'/empty-headers',options)).json());
        await read({headers:{Accept:''}});
        await read({method:'POST',body:'payload',headers:{Accept:'','Content-Type':'','X-Empty':'','X-Value':'sent'}});
        await read({method:'POST',body:new Uint8Array([98,105,110]),headers:{'X-Value':'binary'}});
        await read({method:'POST',body:new Blob(['blob']),headers:{'X-Value':'blob'}});
        await read({method:'POST',body:'text',headers:{'X-Value':'string'}});
        return results;
      },origin);
      assert.deepEqual(actual,[1,2,5,6,7].map(index=>nativeHeaders[index]),filename+' differs from native Fetch');
      assert.equal(requests.some(url=>url.endsWith('/must-not-be-used.wasm')),false);
      if(filename==='libcurl_full.js')assert.deepEqual(requests.filter(url=>url.includes('.wasm')),[],'Bundled runtime fetched external WASM');
      results.push(filename);
    }finally{await page.close();}
  }
  return results;
}
