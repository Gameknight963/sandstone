async page=>{
  const origin='https://svg-use.test',svg='http://www.w3.org/2000/svg',xlink='http://www.w3.org/1999/xlink';
  const sprite=`<?xml-stylesheet type="text/css" href="/sprite.css"?><svg xmlns="${svg}"><style>.accent{fill:currentColor}</style><defs><rect id="shape" width="32" height="32" fill="lime"/></defs><symbol id="green" viewBox="0 0 32 32"><use href="#shape"/></symbol><symbol id="blue" viewBox="0 0 32 32"><rect width="32" height="32" fill="blue"/></symbol><symbol id="accent" viewBox="0 0 32 32"><rect class="accent" width="32" height="32"/></symbol><symbol id="secure" viewBox="0 0 32 32"><rect width="32" height="32" fill="purple"/><image href="${origin}/nested-image.svg" width="32" height="32"/><use href="${origin}/nested-use.svg#blue"/></symbol><script>globalThis.externalSVGExecuted=true;<\/script></svg>`;
  const stylesheet='@import "/sprite-import.css";',importedCSS='.accent{fill:cyan!important}';
  const redirected=`<svg xmlns="${svg}"><symbol id="redirected" viewBox="0 0 32 32"><use href="./inner.svg#blue"/></symbol></svg>`;
  const html=`<!doctype html><body style="margin:0"><svg id="sample" xmlns="${svg}" xmlns:xlink="${xlink}" width="192" height="32" style="background:white;color:red;color-scheme:light"><defs><rect id="local" width="32" height="32" fill="orange"/></defs><use id="modern" href="/sprite.svg#green" width="32" height="32"/><use id="legacy" x="32" xlink:href="/sprite.svg#blue" width="32" height="32"/><use id="inline" x="64" href="#local" width="32" height="32"/><use id="styled" x="96" href="/sprite.svg#accent" width="32" height="32"/><use id="secure" x="128" href="/sprite.svg#secure" width="32" height="32"/><use id="absolute" x="160" href="${origin}/start#local" width="32" height="32"/></svg>`;
  const native=await page.context().newPage(),nativeRequests=[];
  await native.route(origin+'/**',route=>{
    const path=new URL(route.request().url()).pathname;nativeRequests.push(path);
    if(path==='/redirect.svg')return route.fulfill({status:302,headers:{Location:'/assets/root.svg'},body:''});
    return route.fulfill({contentType:path.endsWith('.svg')?'image/svg+xml':path.endsWith('.css')?'text/css':'text/html',body:path==='/assets/root.svg'?redirected:path.endsWith('.svg')?sprite:path==='/sprite.css'?stylesheet:path==='/sprite-import.css'?importedCSS:html});
  });
  const direct=[],observe=request=>{if(/^https?:/.test(request.url()))direct.push(request.url());},block=route=>route.abort();
  page.on('request',observe);
  await page.route(/^https?:/,block);
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const wait=async(proxy,source,label)=>{
    const deadline=Date.now()+4000;
    while(!await evaluate(proxy,source)){
      if(Date.now()>deadline)throw new Error('SVG use timed out: '+label+' proxy='+proxy+' requests='+JSON.stringify({proxy:await page.evaluate(()=>svgUseRequests),native:nativeRequests}));
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  };
  const compare=async label=>{
    const expected=await native.locator('#sample').screenshot({animations:'disabled'});
    const actual=await page.frameLocator('iframe[frame-id]').locator('#sample').screenshot({animations:'disabled'});
    if(!expected.equals(actual))throw new Error('SVG use rendering differs: '+label+' '+JSON.stringify({direct,nativeRequests}));
    if(direct.length)throw new Error('SVG use direct request: '+label+' '+JSON.stringify(direct));
  };
  try{
    await page.evaluate(({origin,html,sprite,stylesheet,importedCSS,redirected})=>{
      const previous=sandstone.network.session.fetch;globalThis.svgUseRequests=[];
      sandstone.network.session.fetch=(url,options)=>{
        if(new URL(url).origin!==origin)return previous(url,options);
        const path=new URL(url).pathname;svgUseRequests.push(path);
        if(path==='/held.svg')return new Promise(resolve=>{globalThis.releaseSVGUse=()=>resolve(new Response(sprite,{headers:{'Content-Type':'image/svg+xml'}}));});
        if(path==='/redirect.svg')return Promise.resolve(new Response(null,{status:302,headers:{Location:'/assets/root.svg'}}));
        return Promise.resolve(new Response(path==='/slow.svg'?sprite.replace('/nested-use.svg','/held.svg'):path==='/assets/root.svg'?redirected:path.endsWith('.svg')?sprite:path==='/sprite.css'?stylesheet:path==='/sprite-import.css'?importedCSS:html,{headers:{'Content-Type':path.endsWith('.svg')?'image/svg+xml':path.endsWith('.css')?'text/css':'text/html'}}));
      };
    },{origin,html,sprite,stylesheet,importedCSS,redirected});
    await native.goto(origin+'/start');await page.evaluate(url=>main_frame.navigate_to(url),origin+'/start');
    for(const proxy of [false,true])await wait(proxy,"['modern','legacy','styled','secure','inline','absolute'].every(id=>document.getElementById(id).getBBox().width===32)",'initial symbols');
    await compare('initial external/local symbols, nested references and inherited styles');
    const change="document.getElementById('modern').href.baseVal='/sprite.svg#blue';true";
    await evaluate(false,change);
    await evaluate(true,"document.getElementById('modern').href.baseVal='/slow.svg#green';true");
    await page.waitForFunction(()=>svgUseRequests.includes('/held.svg'));
    await evaluate(true,change);
    for(const proxy of [false,true])await wait(proxy,"document.getElementById('modern').getBBox().width===32",'replacement');
    await page.evaluate(()=>releaseSVGUse());await new Promise(resolve=>setTimeout(resolve,60));
    await compare('stale request cannot replace the current symbol');
    const copies=`(()=>{const original=document.getElementById('modern'),cloned=original.cloneNode(true),imported=document.importNode(original,true);cloned.setAttribute('x','64');imported.setAttribute('x','160');document.getElementById('inline').replaceWith(cloned);document.getElementById('absolute').replaceWith(imported);return JSON.stringify([cloned,imported].map(node=>({href:node.href.baseVal,attribute:node.getAttribute('href'),native:node instanceof SVGUseElement})));})()`;
    const expected=await evaluate(false,copies),actual=await evaluate(true,copies);
    if(expected!==actual)throw new Error('SVG use cloning/import reflection differs: '+JSON.stringify({expected,actual}));
    for(const proxy of [false,true])await wait(proxy,"[...document.querySelectorAll('use')].filter(node=>node.parentNode.id==='sample').every(node=>node.getBBox().width===32)",'cloned symbols');
    await compare('cloning and import');
    const based=`(()=>{const base=document.createElement('base');base.href='${origin}/sprite.svg';document.head.append(base);document.getElementById('styled').href.baseVal='#local';return true;})()`;
    for(const proxy of [false,true]){await evaluate(proxy,based);await wait(proxy,"document.getElementById('styled').getBBox().width===32",'fragment with an external base');}
    await compare('local fragments remain local with an external document base');
    // Compare the relay's redirect with the native resource at its final URL.
    for(const proxy of [false,true]){await evaluate(proxy,`document.getElementById('modern').href.baseVal='${proxy?'/redirect.svg':'/assets/root.svg'}#redirected';true`);await wait(proxy,"document.getElementById('modern').getBBox().width===32",'redirected symbol dependencies');}
    await compare('redirected sprites resolve dependencies against the final URL');
    const authoredBlob=`(()=>{globalThis.authoredSpriteURL=URL.createObjectURL(new Blob(['<svg xmlns="${svg}"><symbol id="icon" viewBox="0 0 32 32"><use href="${origin}/nested-use.svg#blue"/></symbol></svg>'],{type:'image/svg+xml'}));document.getElementById('styled').href.baseVal=authoredSpriteURL+'#icon';return true;})()`;
    for(const proxy of [false,true]){await evaluate(proxy,authoredBlob);await wait(proxy,"document.getElementById('styled').getBBox().width===32",'authored blob sprite');}
    await compare('authored blobs also relay their nested symbols');
    for(const proxy of [false,true])await evaluate(proxy,'URL.revokeObjectURL(authoredSpriteURL);true');
    const flags=await evaluate(true,"typeof externalSVGExecuted==='undefined'");
    const requests=await page.evaluate(()=>svgUseRequests);
    if(!flags||!requests.includes('/nested-image.svg')||!requests.includes('/nested-use.svg')||!requests.includes('/sprite-import.css')||!requests.includes('/assets/inner.svg')||direct.length)throw new Error('SVG resource isolation failed: '+JSON.stringify({flags,requests,nativeRequests,direct}));
    return ['External SVG use sprites, local symbols and inherited styles render through the relay','SVG use cloning/import and source races preserve native rendering','External SVG symbol documents cannot execute scripts or issue direct subrequests'];
  }finally{await native.close();await page.unroute(/^https?:/,block);page.off('request',observe);}
}
