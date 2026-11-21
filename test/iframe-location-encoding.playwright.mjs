import assert from 'node:assert/strict';

export async function verifyIframeLocationEncoding(page){
  const nativeContext=await page.context().browser().newContext(),native=await nativeContext.newPage(),fixture=await page.context().newPage();
  const origin='https://iframe-encoding.test',query='?q=\u0422\u0435\u0441\u0442&japanese=\u65e5\u672c',errors=[],direct=[];
  const parentHTML='<!doctype html><base href="/parent-assets/"><body><script>globalThis.loads=0;globalThis.conversions=0;</script>';
  const childHTML='<!doctype html><base href="/child-assets/"><body>Child';
  let parentEncoding='UTF-8',childEncoding='UTF-8';
  const read=(proxy,source)=>proxy?fixture.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const wait=async(predicate,label)=>{const deadline=Date.now()+8000;while(!await predicate()){if(Date.now()>deadline)throw new Error(label);await fixture.waitForTimeout(20);}};
  try{
    for(const surface of [native,fixture])surface.on('pageerror',error=>errors.push(error.message));
    await native.route(origin+'/**',route=>{
      const parent=new URL(route.request().url()).pathname==='/parent';
      return route.fulfill({contentType:'text/html;charset='+(parent?parentEncoding:childEncoding),body:parent?parentHTML:childHTML});
    });
    await fixture.goto(new URL('../example/bundled.html',import.meta.url).href);
    await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.evaluate(({parentHTML,childHTML})=>{
      main_frame.on_load=()=>{};
      globalThis.iframeEncoding={parent:'UTF-8',child:'UTF-8'};
      sandstone.network.session.fetch=async url=>{
        const parent=new URL(url).pathname==='/parent';
        return new Response(parent?parentHTML:childHTML,{headers:{'content-type':'text/html;charset='+iframeEncoding[parent?'parent':'child'],'cache-control':'no-store'}});
      };
    },{parentHTML,childHTML});
    for(const encodings of [['windows-1251','UTF-8'],['Shift_JIS','windows-1252'],['windows-1252','Shift_JIS'],['UTF-8','windows-1251']]){
      [parentEncoding,childEncoding]=encodings;
      await fixture.evaluate(([parent,child])=>{iframeEncoding={parent,child};},encodings);
      for(const method of ['href','assign','replace','search','coercion']){
        const results=[];
        for(const proxy of [false,true]){
          console.log(JSON.stringify({fixture:'Iframe Location encoding',encodings,method,proxy}));
          if(proxy)await fixture.evaluate(url=>main_frame.navigate_to(url),origin+'/parent');else await native.goto(origin+'/parent');
          await read(proxy,'globalThis.child=document.createElement("iframe");child.onload=()=>loads++;child.src='+JSON.stringify(origin+'/child')+';document.body.append(child);true');
          await wait(()=>read(proxy,'loads===1'),'The encoded iframe did not load');
          await read(proxy,'globalThis.savedWindow=child.contentWindow;globalThis.originalEncodings=[document.characterSet,savedWindow.document.characterSet];true');
          const argument=JSON.stringify('landing'+query);
          const command=method==='coercion'?'savedWindow.location.assign({toString(){conversions++;document.querySelector("base").href="/changed/";return '+argument+';}})':method==='href'?'savedWindow.location.href='+argument:method==='search'?'savedWindow.location.search='+JSON.stringify(query):'savedWindow.location.'+method+'('+argument+')';
          await read(proxy,command+';true');
          await wait(()=>read(proxy,'loads===2'),'The encoded Location navigation did not load');
          results.push(JSON.parse(await read(proxy,'JSON.stringify({url:savedWindow.location.href,encodings:originalEncodings,conversions})')));
        }
        assert.deepEqual(results[1],results[0],parentEncoding+' -> '+childEncoding+' '+method);
        assert.equal(new URL(results[0].url).pathname,method==='search'?'/child':method==='coercion'?'/changed/landing':'/parent-assets/landing');
        assert.equal(results[0].conversions,method==='coercion'?1:0);
        if(parentEncoding==='windows-1251')assert.ok(results[0].url.includes(method==='search'?'%D0%A2%D0%B5%D1%81%D1%82':'%D2%E5%F1%F2'));
      }
    }
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
  }finally{await fixture.close();await nativeContext.close();}
  return ['Parent-to-iframe Location navigation uses the calling document base and encoding while search setters retain UTF-8','Cross-frame URL coercion runs once before reading a changed document base'];
}
