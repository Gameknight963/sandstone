async page=>{
  const origin='https://media-policy.test',assets='https://assets.media-policy.test';
  const blank='<!doctype html><body>',svg='<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="green"/></svg>';
  const bytes=new Uint8Array(1644),view=new DataView(bytes.buffer),word=(offset,value)=>bytes.set(new TextEncoder().encode(value),offset);
  word(0,'RIFF');view.setUint32(4,1636,true);word(8,'WAVE');word(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,8000,true);view.setUint32(28,16000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);word(36,'data');view.setUint32(40,1600,true);
  const wav=[...bytes];
  const native=await page.context().newPage(),nativeRequests=[];
  await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:blank}));
  await native.route(assets+'/**',async route=>{
    const headers=await route.request().allHeaders();
    nativeRequests.push({path:new URL(route.request().url()).pathname,origin:headers.origin||null,referer:headers.referer||null,cookie:headers.cookie||null});
    const audio=route.request().url().endsWith('.wav');
    await route.fulfill({contentType:audio?'audio/wav':'image/svg+xml',headers:{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Credentials':'true','Cache-Control':'no-store'},body:audio?Buffer.from(wav):svg});
  });
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const direct=[],observe=request=>{if(/^https?:/.test(request.url()))direct.push(request.url());},block=route=>route.abort();
  page.on('request',observe);await page.route(/^https?:/,block);
  try{
    await native.goto(origin+'/page');
    await page.evaluate(async ({origin,assets,blank,svg,wav})=>{
      const previous=sandstone.network.session.fetch;
      globalThis.mediaPolicyRequests=[];
      sandstone.network.session.fetch=async (url,options)=>{
        if(new URL(url).origin!==assets)return previous(url,options);
        const headers=new Headers(options.headers);
        mediaPolicyRequests.push({path:new URL(url).pathname,origin:headers.get('origin'),referer:headers.get('referer'),cookie:headers.get('cookie')});
        if(url.endsWith('/pending.svg')&&!headers.has('origin')){
          await new Promise(resolve=>globalThis.releaseMediaPolicy=resolve);
          globalThis.mediaPolicyReleased=true;
          return new Response(svg.replace('width="8"','width="16"'),{headers:{'Content-Type':'image/svg+xml','Cache-Control':'no-store'}});
        }
        const audio=url.endsWith('.wav');
        return new Response(audio?new Uint8Array(wav):svg,{headers:{'Content-Type':audio?'audio/wav':'image/svg+xml','Cache-Control':'no-store'}});
      };
      main_frame.special_pages[origin+'/page']=blank;await main_frame.navigate_to(origin+'/page');
    },{origin,assets,blank,svg,wav});
    const cookie='mediaPolicy=present;domain=media-policy.test;path=/;secure;samesite=none';
    await evaluate(false,`document.cookie=${JSON.stringify(cookie)};true`);
    await evaluate(true,`document.cookie=${JSON.stringify(cookie)};true`);
    const cases=[
      ['immediate',`image.src=url;image.crossOrigin='anonymous'`],
      ['late',`image.src=url`,`image.crossOrigin='anonymous'`],
      ['same',`image.crossOrigin='anonymous';image.src=url`,`image.crossOrigin='anonymous'`],
      ['invalid',`image.crossOrigin='anonymous';image.src=url`,`image.crossOrigin='invalid'`],
      ['remove',`image.crossOrigin='anonymous';image.src=url`,`image.removeAttribute('crossorigin')`],
      ['credentials',`image.crossOrigin='anonymous';image.src=url`,`image.crossOrigin='use-credentials'`],
      ['attribute',`image.src=url`,`Element.prototype.setAttribute.call(image,'CROSSORIGIN','anonymous')`],
      ['attribute-value',`image.crossOrigin='use-credentials';image.src=url`,`image.getAttributeNode('crossorigin').value='anonymous'`],
      ['attribute-text',`image.crossOrigin='use-credentials';image.src=url`,`image.getAttributeNode('crossorigin').textContent='anonymous'`],
      ['attribute-map',`image.crossOrigin='anonymous';image.src=url`,`image.attributes.removeNamedItem('crossorigin')`],
      ['attribute-node',`image.src=url`,`const attribute=document.createAttribute('crossorigin');attribute.value='anonymous';image.setAttributeNode(attribute)`],
      ['policy-immediate',`image.src=url;image.referrerPolicy='no-referrer'`],
      ['policy-late',`image.src=url`,`image.referrerPolicy='no-referrer'`],
      ['picture',`const picture=document.createElement('picture'),source=document.createElement('source');source.srcset=url;image.crossOrigin='anonymous';image.referrerPolicy='no-referrer';picture.append(source,image);document.body.append(picture)`,`image.removeAttribute('crossorigin')`],
      ['audio',`image.preload='auto';image.src=url;image.crossOrigin='anonymous'`,`image.crossOrigin='use-credentials'`,'audio'],
      ['video',`image.preload='auto';image.src=url;image.crossOrigin='anonymous'`,`image.crossOrigin='use-credentials'`,'video']
    ];
    for(const [name,setup,change,kind] of cases){
      const path='/'+name+(kind?'.wav':'.svg');
      const values=[];
      for(const proxy of [false,true]){
        await evaluate(proxy,`(()=>{const image=${kind?'document.createElement('+JSON.stringify(kind)+')':'new Image()'},url=${JSON.stringify(assets+path)};globalThis.policyImage=image;${setup};return true})()`);
        const ready=async()=>{
          const deadline=Date.now()+8000;
          while(!await evaluate(proxy,kind?`policyImage.readyState>=1`:`policyImage.complete&&policyImage.naturalWidth===8`)){
            if(Date.now()>deadline)throw new Error('Media policy image failed: '+name+' proxy='+proxy);
            await new Promise(resolve=>setTimeout(resolve,20));
          }
        };
        await ready();
        if(change){
          await evaluate(proxy,`(()=>{const image=policyImage;${change};return true})()`);
          // Includes native no-op changes, which must not produce another fetch.
          await new Promise(resolve=>setTimeout(resolve,75));await ready();
        }
        const requests=proxy?await page.evaluate(()=>mediaPolicyRequests):nativeRequests;
        values.push(requests.filter(request=>request.path===path));
      }
      if(JSON.stringify(values[0])!==JSON.stringify(values[1]))throw new Error('Media policy '+name+' differs: '+JSON.stringify(values));
    }
    await evaluate(true,`globalThis.policyImage=new Image();policyImage.src=${JSON.stringify(assets+'/pending.svg')};true`);
    await page.waitForFunction(()=>typeof releaseMediaPolicy==='function');
    await evaluate(true,`policyImage.crossOrigin='use-credentials';true`);
    const deadline=Date.now()+8000;
    while(!await evaluate(true,`policyImage.complete&&policyImage.naturalWidth===8`)){
      if(Date.now()>deadline)throw new Error('A pending image policy change did not restart the relay request');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    await page.evaluate(()=>releaseMediaPolicy());await page.waitForFunction(()=>mediaPolicyReleased);
    await evaluate(true,`new Promise(resolve=>setTimeout(resolve,75))`);
    if(!await evaluate(true,`policyImage.naturalWidth===8`))throw new Error('An obsolete policy response replaced the current image');
    if(direct.length)throw new Error('Media policy updates issued direct requests: '+JSON.stringify(direct));
    return ['Image CORS changes preserve native Origin, credentials, reloads and no-op updates','Picture sources inherit image CORS/referrer policy and stay on the relay'];
  }finally{
    await native.close();page.off('request',observe);await page.unroute(/^https?:/,block);
  }
}
