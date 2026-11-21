import assert from 'node:assert/strict';

export async function verifyJavascriptLinks(page){
  const native=await page.context().newPage(),fixture=await page.context().newPage(),direct=[],errors=[];
  const origin='https://javascript-links.test',html='<!doctype html><body><script>globalThis.urlResults=[];</script>';
  const cases=[
    ['javascript:urlResults.push(%22escaped%20space%22);void%200','escaped space'],
    ['javascript:urlResults.push("caf%C3%A9 %f0%9f%8c%8d");void 0','café 🌍'],
    ['javascript:urlResults.push("raw é + %2B %2520 %");void 0','raw é + + %20 %'],
    ['javascript:urlResults.push("query?%3F#%23");void 0','query??##'],
    ['javascript:%EF%BB%BFurlResults.push("BOM");void 0','BOM'],
    ['JAVASCRIPT:/*line*/%0D%0AurlResults.push("line%20break");void%200','line break'],
    ['javascript:urlResults.push("%00");void 0','\0'],
    ['javascript:urlResults.push("%FF%E9%2G%2");void 0','ÿé%2G%2'],
    ['javascript:urlResults.push("%E2%28%A1");void 0','â(¡'],
    ['javascript:urlResults.push("caf%C3%A9 é %FF");void 0','cafÃ© Ã© ÿ'],
    ['javascript:urlResults.push("%80%9F");void 0','\u0080\u009f']
  ];
  for(const surface of [native,fixture])surface.on('pageerror',error=>errors.push(error.message));
  try{
    await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html; charset='+(new URL(route.request().url()).searchParams.get('charset')||'UTF-8'),body:html}));
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.evaluate(({html})=>{
      main_frame.on_load=()=>{};
      sandstone.network.session.fetch=async url=>new Response(html,{headers:{'content-type':'text/html; charset='+(new URL(url).searchParams.get('charset')||'UTF-8'),'cache-control':'no-store'}});
    },{html});
    const read=(proxy,source)=>proxy?fixture.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
    for(const charset of ['UTF-8','windows-1252']){
      const results=[];
      for(const proxy of [false,true]){
        const url=origin+'/start?charset='+charset;
        if(proxy)await fixture.evaluate(url=>main_frame.navigate_to(url),url);else await native.goto(url);
        const reflections=[];
        for(const [index,[href]] of cases.entries()){
          reflections.push(await read(proxy,`(()=>{const link=document.createElement('a');link.href=${JSON.stringify(href)};link.textContent='Run script';document.body.append(link);const reflected=link.href;link.click();link.remove();return reflected;})()`));
          const deadline=Date.now()+3000;
          while(!await read(proxy,'urlResults.length==='+String(index+1))){if(Date.now()>deadline)throw new Error('JavaScript link did not run: '+JSON.stringify({proxy,charset,href}));await fixture.waitForTimeout(20);}
        }
        results.push({reflections,values:JSON.parse(await read(proxy,'JSON.stringify(urlResults)'))});
      }
      assert.deepEqual(results[0].values,cases.map(([,expected])=>expected),'Native JavaScript URL decoding '+charset);
      assert.deepEqual(results[1],results[0],'Relayed JavaScript links match native URL decoding '+charset);
    }
    assert.deepEqual(direct,[],'JavaScript links bypassed the relay');
    assert.deepEqual(errors,[],'JavaScript links raised script errors');
  }finally{await native.close();await fixture.close();}
  return ['JavaScript links preserve native percent decoding, UTF-8 and legacy byte fallback independently of document encoding'];
}
