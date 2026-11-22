import assert from 'node:assert/strict';
import {wait_for} from './wait-for.mjs';

export async function verifySearchResults(page){
  const search='https://html.duckduckgo.com/html/?q=hello',destination='https://en.wikipedia.org/wiki/Hello';
  const redirect='https://duckduckgo.com/l/?uddg='+encodeURIComponent(destination)+'&rut=test';
  const errors=[],direct=[],onError=error=>errors.push(error.message),onRequest=request=>{if(/^https?:/.test(request.url()))direct.push(request.url());};
  page.on('pageerror',onError);page.on('request',onRequest);
  try{
    await page.evaluate(({search,destination,redirect})=>{
      globalThis.searchPrevious=sandstone.network.session.fetch;globalThis.searchRequests=[];
      sandstone.network.session.fetch=(url,options)=>{
        if(![search,destination,redirect].includes(String(url)))return searchPrevious(url,options);
        searchRequests.push(String(url));
        const body=String(url)===search?'<a class="result__a" href="'+redirect.replaceAll('&','&amp;')+'">Hello - Wikipedia</a>':String(url)===destination?'<title>Hello - Wikipedia</title><h1>Hello</h1>':'<body></body>';
        return Promise.resolve(new Response('<!doctype html>'+body,{headers:{'content-type':'text/html'}}));
      };
    },{search,destination,redirect});
    await page.evaluate(url=>main_frame.navigate_to(url),search);
    await page.frameLocator('iframe[frame-id]').getByRole('link',{name:'Hello - Wikipedia'}).click();
    await wait_for(()=>page.evaluate(destination=>String(main_frame.url)===destination&&!main_frame.is_navigating,destination),{timeout:10000});
    assert.equal(await page.evaluate(()=>main_frame.eval_js('document.querySelector("h1").textContent')),'Hello');
    assert.deepEqual(await page.evaluate(()=>searchRequests),[search,destination],'The result requested a script-dependent redirect page');
    // Pasting an existing result redirect into the address bar must work too.
    await page.evaluate(url=>main_frame.navigate_to(url),redirect);
    assert.equal(await page.evaluate(()=>String(main_frame.url)),destination);
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['DuckDuckGo HTML result clicks and pasted redirect URLs open the encoded destination through the relay'];
  }finally{
    page.off('pageerror',onError);page.off('request',onRequest);
    await page.evaluate(()=>{sandstone.network.session.fetch=searchPrevious;delete globalThis.searchPrevious;delete globalThis.searchRequests;});
  }
}
