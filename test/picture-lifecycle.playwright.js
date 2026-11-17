async page=>{
  const origin='https://picture-lifecycle.test',assets='https://assets.picture-lifecycle.test',blank='<!doctype html><body>';
  const svg=width=>'<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="8"><rect width="'+width+'" height="8" fill="green"/></svg>';
  const native=await page.context().newPage(),nativeRequests=[];
  await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:blank}));
  await native.route(assets+'/**',async route=>{
    const headers=await route.request().allHeaders();
    nativeRequests.push({path:new URL(route.request().url()).pathname,origin:headers.origin||null,referer:headers.referer||null,cookie:headers.cookie||null});
    await route.fulfill({contentType:'image/svg+xml',headers:{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Credentials':'true','Cache-Control':'no-store'},body:svg(headers.cookie?16:8)});
  });
  const evaluate=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js(source),source):native.evaluate(source=>eval(source),source);
  const direct=[],observe=request=>{if(/^https?:/.test(request.url()))direct.push(request.url());},block=route=>route.abort();
  page.on('request',observe);await page.route(/^https?:/,block);
  try{
    await native.goto(origin+'/page');
    await page.evaluate(async ({origin,assets,blank})=>{
      const previous=sandstone.network.session.fetch;
      globalThis.pictureLifecycleRequests=[];
      sandstone.network.session.fetch=async (url,options)=>{
        if(new URL(url).origin!==assets)return previous(url,options);
        const headers=new Headers(options.headers);
        pictureLifecycleRequests.push({path:new URL(url).pathname,origin:headers.get('origin'),referer:headers.get('referer'),cookie:headers.get('cookie')});
        if(url.endsWith('/pending.svg')&&!headers.has('cookie')){
          await new Promise(resolve=>globalThis.releasePictureSource=resolve);
          globalThis.pictureSourceReleased=true;
        }
        const width=headers.has('cookie')?16:8;
        return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="8"><rect width="'+width+'" height="8" fill="green"/></svg>',{headers:{'Content-Type':'image/svg+xml','Cache-Control':'no-store'}});
      };
      main_frame.special_pages[origin+'/page']=blank;await main_frame.navigate_to(origin+'/page');
    },{origin,assets,blank});
    const results=[];
    for(const proxy of [false,true]){
      const ready=async(source)=>{
        const deadline=Date.now()+8000;
        while(!await evaluate(proxy,source)){
          if(Date.now()>deadline)throw new Error('Picture lifecycle timed out: '+source+' proxy='+proxy+' '+await evaluate(proxy,`JSON.stringify({html:document.body.innerHTML,src:firstImage.currentSrc,width:firstImage.naturalWidth})`)+' requests='+JSON.stringify(await records()));
          await new Promise(resolve=>setTimeout(resolve,20));
        }
      };
      const records=async()=>proxy?page.evaluate(()=>pictureLifecycleRequests):nativeRequests;
      const cookie='picturePolicy=present;domain=picture-lifecycle.test;path=/;secure;samesite=none';
      await evaluate(proxy,`document.cookie=${JSON.stringify(cookie)};globalThis.pictureSource=document.createElement('source');pictureSource.srcset=${JSON.stringify(assets+'/delayed.svg')};true`);
      await new Promise(resolve=>setTimeout(resolve,75));
      if((await records()).length)throw new Error('A detached source fetched before it had an image: '+JSON.stringify(await records())+' proxy='+proxy);
      await evaluate(proxy,`globalThis.picture=document.createElement('picture');picture.append(pictureSource);document.body.append(picture);true`);
      await new Promise(resolve=>setTimeout(resolve,75));
      if((await records()).length)throw new Error('A picture without an image fetched its source: proxy='+proxy);
      await evaluate(proxy,`globalThis.firstImage=new Image();firstImage.crossOrigin='anonymous';firstImage.referrerPolicy='no-referrer';picture.append(firstImage);true`);
      await ready(`firstImage.complete&&firstImage.naturalWidth===8`);
      await evaluate(proxy,`globalThis.secondPicture=document.createElement('picture');globalThis.secondImage=new Image();secondImage.crossOrigin='use-credentials';secondPicture.append(secondImage);document.body.append(secondPicture);secondPicture.prepend(pictureSource);true`);
      await ready(`secondImage.complete&&secondImage.naturalWidth===16`);
      await evaluate(proxy,`globalThis.replacement=new Image();replacement.crossOrigin='anonymous';replacement.referrerPolicy='no-referrer';secondImage.replaceWith(replacement);true`);
      await ready(`replacement.complete&&replacement.naturalWidth===8`);
      // Sources after the image do not participate in picture selection.
      await evaluate(proxy,`globalThis.ignored=document.createElement('source');ignored.srcset=${JSON.stringify(assets+'/ignored.svg')};secondPicture.append(ignored);true`);
      await new Promise(resolve=>setTimeout(resolve,75));
      const requests=await records();
      if(requests.some(request=>request.path==='/ignored.svg'))throw new Error('A source after the image was fetched: proxy='+proxy);
      await evaluate(proxy,`customElements.define('x-detached-picture',class extends HTMLPictureElement{},{extends:'picture'});globalThis.customPicture=new(customElements.get('x-detached-picture'))();globalThis.customSource=document.createElement('source');customSource.srcset=${JSON.stringify(assets+'/custom.svg')};globalThis.customImage=new Image();customImage.crossOrigin='anonymous';customImage.referrerPolicy='no-referrer';customPicture.append(customSource,customImage);true`);
      await ready(`customImage.complete&&customImage.naturalWidth===8`);
      await evaluate(proxy,`globalThis.customReplacement=new Image();customReplacement.crossOrigin='use-credentials';customImage.replaceWith(customReplacement);true`);
      await ready(`customReplacement.complete&&customReplacement.naturalWidth===16`);
      results.push(await records());
    }
    if(JSON.stringify(results[0])!==JSON.stringify(results[1]))throw new Error('Picture lifecycle requests differ: '+JSON.stringify(results));
    await evaluate(true,`globalThis.pendingSource=document.createElement('source');pendingSource.srcset=${JSON.stringify(assets+'/pending.svg')};picture.prepend(pendingSource);true`);
    await page.waitForFunction(()=>typeof releasePictureSource==='function');
    await evaluate(true,`secondPicture.prepend(pendingSource);replacement.crossOrigin='use-credentials';true`);
    const deadline=Date.now()+8000;
    while(!await evaluate(true,`replacement.complete&&replacement.currentSrc.endsWith('/pending.svg')&&replacement.naturalWidth===16`)){
      if(Date.now()>deadline)throw new Error('A pending source did not use its replacement owner');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    await page.evaluate(()=>releasePictureSource());await page.waitForFunction(()=>pictureSourceReleased);
    await evaluate(true,`new Promise(resolve=>setTimeout(resolve,75))`);
    if(!await evaluate(true,`replacement.naturalWidth===16`))throw new Error('A response for an old picture owner replaced the current resource');
    if(direct.length)throw new Error('Picture changes issued direct requests: '+JSON.stringify(direct));
    return ['Delayed picture sources and replacement images inherit native request policies','Orphan sources and sources after the image do not issue requests'];
  }finally{
    await native.close();page.off('request',observe);await page.unroute(/^https?:/,block);
  }
}
