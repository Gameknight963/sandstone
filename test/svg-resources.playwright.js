async page=>{
  const origin='https://svg-resources.test',assetOrigin='https://svg-images.test',svg='http://www.w3.org/2000/svg',xlink='http://www.w3.org/1999/xlink';
  const blank='<!doctype html><body style="margin:0"><main id="fixture"></main>';
  const resources=`<!doctype html><body style="margin:0"><svg id="sample" xmlns="${svg}" xmlns:xlink="${xlink}" width="128" height="32" style="background:white;color-scheme:light">
    <image id="ordinary" width="32" height="32" href="${origin}/image.svg#left"/>
    <image id="legacy" x="32" width="32" height="32" xlink:href="${origin}/legacy.svg"/>
    <defs><filter id="image-filter" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="64" y="0" width="32" height="32" color-interpolation-filters="sRGB"><feImage id="effect" x="64" y="0" width="32" height="32" href="${origin}/filter.svg"/></filter></defs>
    <rect x="64" width="32" height="32" filter="url(#image-filter)"/>
    <defs><rect id="local-shape" width="32" height="32" fill="orange"/><filter id="local-filter" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="96" y="0" width="32" height="32"><feImage x="96" width="32" height="32" href="#local-shape"/></filter></defs><rect x="96" width="32" height="32" filter="url(#local-filter)"/>
    </svg><script>globalThis.svgLoads=[];for(const id of ['ordinary','legacy','effect'])document.getElementById(id).addEventListener('load',()=>svgLoads.push(id));<\/script>`;
  const image='<svg xmlns="'+svg+'" width="32" height="32"><view id="left" viewBox="0 0 16 32"/><rect width="16" height="32" fill="lime"/><rect x="16" width="16" height="32" fill="blue"/></svg>';
  const blue='<svg xmlns="'+svg+'" width="32" height="32"><rect width="32" height="32" fill="blue"/></svg>';
  const failure=`<!doctype html><body style="margin:0"><svg id="recovery-canvas" width="32" height="32" style="background:white;color-scheme:light"><image id="recovery" width="32" height="32" href="${origin}/missing.svg" onerror="globalThis.failureURL=location.href;this.href.baseVal='/fallback.svg'"></image></svg><script>globalThis.svgRecovered=false;document.getElementById('recovery').addEventListener('load',()=>svgRecovered=true);<\/script>`;
  const native=await page.context().newPage();
  const nativeRequests=[];
  const fulfill=route=>{const request=route.request(),path=new URL(request.url()).pathname;nativeRequests.push({path,origin:request.headers().origin||null,referer:request.headers().referer||null});return route.fulfill({status:path==='/missing.svg'?404:200,contentType:path.endsWith('.svg')?'image/svg+xml':'text/html',headers:{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Credentials':'true'},body:path.endsWith('.svg')?path==='/replacement.svg'?blue:image:path==='/resources'?resources:path==='/failure'?failure:blank});};
  await native.route(origin+'/**',fulfill);await native.route(assetOrigin+'/**',fulfill);
  const cases=[
    ['href and xlink precedence',"subject.setAttributeNS(xlink,'xlink:href','#legacy');capture();subject.setAttribute('href','#modern');capture();subject.setAttributeNS(xlink,'xlink:href','#ignored');capture();subject.removeAttribute('href');capture();subject.setAttribute('href','');capture()"],
    ['animated string setters',"subject.setAttributeNS(xlink,'xlink:href','#legacy');capture();subject.href.baseVal='#updated';capture();subject.removeAttributeNS(xlink,'href');capture();subject.href.baseVal='#again';capture()"],
    ['case sensitive SVG attributes',"subject.setAttribute('HREF','#uppercase');capture();subject.setAttribute('href','#lowercase');capture();subject.removeAttribute('HREF');capture()"],
    ['borrowed attribute setters',"Element.prototype.setAttribute.call(subject,'href','#borrowed');capture();Element.prototype.setAttributeNS.call(subject,xlink,'other:href','#namespaced');capture();Element.prototype.removeAttribute.call(subject,'href');capture()"],
    ['attribute value writes',"subject.setAttribute('href','#one');const attr=subject.getAttributeNode('href');attr.value='#two';capture();attr.nodeValue='#three';capture();attr.textContent='#four';capture();subject.removeAttributeNode(attr);snapshots.push({detached:attr.value,owner:attr.ownerElement===null});capture()"],
    ['attribute node attachment',"const attr=document.createAttribute('href');attr.value='#attached';subject.setAttributeNode(attr);capture();const next=document.createAttributeNS(xlink,'xlink:href');next.value='#attached-legacy';subject.setAttributeNodeNS(next);capture();subject.removeAttributeNode(attr);capture()"],
    ['named attribute maps',"const attr=document.createAttribute('href');attr.value='#map';subject.attributes.setNamedItem(attr);capture();const removed=subject.attributes.removeNamedItem('href');snapshots.push({removed:removed.value,owner:removed.ownerElement===null});capture()"],
    ['reentrant animated string conversion',"subject.href.baseVal={toString(){subject.setAttributeNS(xlink,'xlink:href','#during');return '#converted'}};capture()"],
    ['animated string validation',"const property=Object.getOwnPropertyDescriptor(SVGAnimatedString.prototype,'baseVal');let calls=0,error;try{property.set.call({}, {toString(){calls++;return '#bad'}})}catch(value){error=value.name}snapshots.push({calls,error});capture()"],
    ['stable native interfaces',"const value=subject.href,map=subject.attributes;subject.setAttribute('href','#one');snapshots.push({same:value===subject.href,map:map===subject.attributes,string:value instanceof SVGAnimatedString,element:subject instanceof SVGElement});capture()"]
  ];
  cases.push(['read-only settings do not mutate',"subject.setAttribute('href','#read');subject.setAttribute('crossorigin','anonymous');const observer=new MutationObserver(()=>{});observer.observe(subject,{attributes:true});subject.getAttribute('crossorigin');subject.getAttributeNS(null,'crossorigin');subject.hasAttribute('crossorigin');subject.hasAttributeNS(null,'crossorigin');snapshots.push({mutations:observer.takeRecords().length});observer.disconnect();capture()"]);
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const run=async(proxy,tag,source)=>{
    if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),origin+'/reflection');else await native.goto(origin+'/reflection');
    return JSON.parse(await evaluate(proxy,`JSON.stringify((()=>{const svg=${JSON.stringify(svg)},xlink=${JSON.stringify(xlink)},subject=document.createElementNS(svg,${JSON.stringify(tag)}),snapshots=[];
      const capture=()=>snapshots.push({base:subject.href.baseVal,animated:subject.href.animVal,href:subject.getAttribute('href'),legacy:subject.getAttributeNS(xlink,'href'),attributes:Array.from(subject.attributes,attr=>({name:attr.name,namespace:attr.namespaceURI,value:attr.value,owner:attr.ownerElement===subject}))});
      capture();${source};return snapshots;})())`));
  };
  const direct=[],pattern=/^https?:/,block=route=>{direct.push(route.request().url());return route.abort();};
  await page.route(pattern,block);
  try{
    await page.evaluate(({origin,assetOrigin,blank,resources,image,blue,failure})=>{
      const previous=sandstone.network.session.fetch;globalThis.svgRequests=[];
      sandstone.network.session.fetch=(url,options)=>{
        if(![origin,assetOrigin].includes(new URL(url).origin))return previous(url,options);
        const path=new URL(url).pathname,headers=new Headers(options.headers);svgRequests.push({path,origin:headers.get('origin'),referer:headers.get('referer')});
        if(path==='/slow.svg')return new Promise(resolve=>{globalThis.releaseSlowSVG=()=>resolve(new Response(image,{headers:{'Content-Type':'image/svg+xml'}}));});
        return Promise.resolve(new Response(path.endsWith('.svg')?path==='/replacement.svg'?blue:image:path==='/resources'?resources:path==='/failure'?failure:blank,{status:path==='/missing.svg'?404:200,headers:{'Content-Type':path.endsWith('.svg')?'image/svg+xml':'text/html','Access-Control-Allow-Origin':origin,'Access-Control-Allow-Credentials':'true'}}));
      };
    },{origin,assetOrigin,blank,resources,image,blue,failure});
    const differences=[];
    for(const tag of ['image','feImage','use'])for(const [name,source] of cases){const expected=await run(false,tag,source),actual=await run(true,tag,source);if(JSON.stringify(actual)!==JSON.stringify(expected))differences.push({tag,name,expected,actual});}
    for(const tag of ['image','feImage'])for(const [index,cors] of [null,'','anonymous','use-credentials','invalid'].entries()){
      const path='/cors-'+tag+'-'+index+'.svg';
      const source=`(()=>{const svg=${JSON.stringify(svg)},root=document.createElementNS(svg,'svg'),image=document.createElementNS(svg,${JSON.stringify(tag)});root.setAttribute('width','32');root.setAttribute('height','32');image.setAttribute('width','32');image.setAttribute('height','32');image.href.baseVal=${JSON.stringify(assetOrigin+path)};
        ${cors===null?'':`image.setAttributeNS(null,'crossorigin',${JSON.stringify(cors)});`}
        if(image instanceof SVGFEImageElement){const filter=document.createElementNS(svg,'filter'),rect=document.createElementNS(svg,'rect');filter.id='cors-filter';filter.append(image);root.append(filter);rect.setAttribute('width','32');rect.setAttribute('height','32');rect.setAttribute('filter','url(#cors-filter)');root.append(rect);}else root.append(image);document.body.append(root);return true;})()`;
      for(const proxy of [false,true]){
        if(proxy)await page.evaluate(url=>main_frame.navigate_to(url),origin+'/reflection');else await native.goto(origin+'/reflection');
        await evaluate(proxy,source);
        const deadline=Date.now()+3000;
        while(!(proxy?await page.evaluate(path=>svgRequests.some(request=>request.path===path),path):nativeRequests.some(request=>request.path===path))){if(Date.now()>deadline)throw new Error('SVG CORS request timed out: '+JSON.stringify({tag,cors,proxy}));await new Promise(resolve=>setTimeout(resolve,20));}
      }
      await new Promise(resolve=>setTimeout(resolve,30));
      const expected=nativeRequests.filter(request=>request.path===path).at(-1),actual=await page.evaluate(path=>svgRequests.filter(request=>request.path===path).at(-1),path);
      if(JSON.stringify(expected)!==JSON.stringify(actual))differences.push({tag,cors,expected,actual});
    }
    await native.goto(origin+'/resources');
    await native.waitForFunction(()=>svgLoads.includes('ordinary')&&svgLoads.includes('legacy'));
    const expected=await native.locator('#sample').screenshot({animations:'disabled'});
    await page.evaluate(url=>main_frame.navigate_to(url),origin+'/resources');
    const deadline=Date.now()+3000;
    while(!await evaluate(true,"svgLoads.includes('ordinary')&&svgLoads.includes('legacy')")){
      if(Date.now()>deadline){differences.push({loadTimeout:true,direct,requests:await page.evaluate(()=>svgRequests)});break;}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const actual=await page.frameLocator('iframe[frame-id]').locator('#sample').screenshot({animations:'disabled'});
    if(!expected.equals(actual))differences.push({rendering:'SVG image/filter pixels differ from native'});
    const reflected=JSON.parse(await evaluate(true,`JSON.stringify((()=>{const original=document.getElementById('ordinary'),copy=original.cloneNode(true),attribute=original.getAttributeNode('href').cloneNode();return {base:copy.href.baseVal,attribute:copy.getAttribute('href'),node:attribute.value};})())`));
    if(Object.values(reflected).some(value=>value!==origin+'/image.svg#left'))differences.push({clonedHref:reflected});
    await evaluate(true,`document.getElementById('ordinary').setAttributeNS(${JSON.stringify(xlink)},'xlink:href',${JSON.stringify(origin+'/ignored.svg')});true`);
    await new Promise(resolve=>setTimeout(resolve,30));
    if(await page.evaluate(()=>svgRequests.some(request=>request.path==='/ignored.svg')))differences.push({inactiveXlinkFetched:true});
    await native.evaluate(()=>{svgLoads=[];document.getElementById('ordinary').href.baseVal='/replacement.svg';});
    await native.waitForFunction(()=>svgLoads.includes('ordinary'));
    await evaluate(true,"svgLoads=[];document.getElementById('ordinary').href.baseVal='/slow.svg';true");
    await page.waitForFunction(()=>svgRequests.some(request=>request.path==='/slow.svg'));
    await evaluate(true,"document.getElementById('ordinary').href.baseVal='/replacement.svg';true");
    const replacementDeadline=Date.now()+3000;
    while(!await evaluate(true,"svgLoads.includes('ordinary')")){if(Date.now()>replacementDeadline)throw new Error('SVG replacement timed out');await new Promise(resolve=>setTimeout(resolve,20));}
    await page.evaluate(()=>releaseSlowSVG());await new Promise(resolve=>setTimeout(resolve,40));
    const replacementExpected=await native.locator('#sample').screenshot({animations:'disabled'}),replacementActual=await page.frameLocator('iframe[frame-id]').locator('#sample').screenshot({animations:'disabled'});
    if(!replacementExpected.equals(replacementActual))differences.push({staleReplacement:'A retired SVG request changed the rendered image'});
    await native.goto(origin+'/failure');await native.waitForFunction(()=>svgRecovered);
    await page.evaluate(url=>main_frame.navigate_to(url),origin+'/failure');
    const recoveryDeadline=Date.now()+3000;
    while(!await evaluate(true,'svgRecovered')){if(Date.now()>recoveryDeadline)throw new Error('Initial SVG error fallback did not run');await new Promise(resolve=>setTimeout(resolve,20));}
    if(await evaluate(true,'failureURL')!==origin+'/failure')differences.push({errorContext:await evaluate(true,'failureURL')});
    const recoveryExpected=await native.locator('#recovery-canvas').screenshot({animations:'disabled'}),recoveryActual=await page.frameLocator('iframe[frame-id]').locator('#recovery-canvas').screenshot({animations:'disabled'});
    if(!recoveryExpected.equals(recoveryActual))differences.push({errorFallback:'SVG fallback rendering differs from native'});
    await evaluate(true,`(()=>{const owner=document.getElementById('recovery').ownerDocument;
      globalThis.ownerImage=owner.createElementNS(${JSON.stringify(svg)},'image');ownerImage.href.baseVal=${JSON.stringify(origin+'/owner-image.svg')};
      globalThis.ownerHTMLImage=owner.createElement('img');ownerHTMLImage.src=${JSON.stringify(origin+'/owner-html.svg')};return true;})()`);
    await page.waitForFunction(()=>svgRequests.some(request=>request.path==='/owner-image.svg')&&svgRequests.some(request=>request.path==='/owner-html.svg'));
    await new Promise(resolve=>setTimeout(resolve,40));
    if(direct.length)differences.push({directHTTP:direct});
    if(differences.length)throw new Error('SVG resource parity: '+JSON.stringify(differences));
    return ['SVG image and feImage resources render through the relay','SVG animated href, xlink precedence, attribute nodes and maps retain native behavior','SVG CORS, source fragments, cloning, errors and cancellation match native behavior','Native ownerDocument factories prepare detached HTML/SVG media'];
  }finally{await native.close();await page.unroute(pattern,block);}
}
