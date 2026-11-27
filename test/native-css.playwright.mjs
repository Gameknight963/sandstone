import assert from 'node:assert/strict';

export async function verifyNativeCSS(page,{blocked=false}={}){
  const direct=[],errors=[];
  const request=request=>{if(/^https?:/.test(request.url()))direct.push(request.url())};
  const error=error=>errors.push(error.message);
  page.on('request',request);page.on('pageerror',error);
  try{
    await page.evaluate(async()=>{
      const previous=sandstone.network.session.fetch;globalThis.nativeCSSRequests=[];
      globalThis.nativeCSSHeld=[];globalThis.releaseNativeCSS=false;
      const image=()=>new Response('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="green"/></svg>',{headers:{'content-type':'image/svg+xml'}});
      sandstone.network.session.fetch=async(url,options)=>{
        if(new URL(url).hostname!=='native-css.test')return previous(url,options);
        nativeCSSRequests.push(new URL(url).pathname);
        if(url.endsWith('/styles.css'))return new Response('@import "supported.css" supports(display:grid);@import "ignored.css" supports(sandstone-unknown:value);\n'+
          '#target{color:rgb(21,43,65);background-image:url(pixel.svg)}\n'.repeat(120),{headers:{'content-type':'text/css'}});
        if(url.endsWith('/supported.css'))return new Response('#target{padding-left:13px}',{headers:{'content-type':'text/css'}});
        if(url.endsWith('/held.svg')&&!releaseNativeCSS)await new Promise(resolve=>nativeCSSHeld.push(resolve));
        return image();
      };
      main_frame.special_pages['https://native-css.test/']='<!doctype html><title>Native CSS</title><link rel="stylesheet" href="styles.css"><div id="target">Target</div><div class="held">Held</div>';
      await main_frame.navigate_to('https://native-css.test/');
    });
    const child=await(await page.locator('iframe[frame-id]').elementHandle()).contentFrame();
    await child.waitForFunction(()=>getComputedStyle(document.getElementById('target')).color==='rgb(21, 43, 65)'&&getComputedStyle(document.getElementById('target')).paddingLeft==='13px');
    await child.evaluate(()=>{
      window.nativeStyle=document.createElement('style');
      nativeStyle.textContent=('.held{background-image:url(held.svg)}\n').repeat(160);
      document.head.append(nativeStyle);window.nativeFirst=nativeStyle.firstChild;
    });
    await page.waitForFunction(()=>nativeCSSHeld.length>0);
    await child.evaluate(()=>{
      nativeStyle.firstChild.appendData('\n.extra{color:rgb(11,22,33)}');
      document.head.append(nativeStyle.cloneNode(true));
      window.nativeResponsiveImage=new Image();nativeResponsiveImage.sizes='2px';
      window.nativeResponsiveLoaded=false;nativeResponsiveImage.addEventListener('load',()=>{nativeResponsiveLoaded=true});
      nativeResponsiveImage.srcset=Array.from({length:500},(_,index)=>'pixel.svg '+(index+1)+'w').join(', ');
      document.body.append(nativeResponsiveImage);
    });
    if(!blocked)await child.waitForFunction(()=>sandstone_frame.native_css_status().calls.restoreParts>0);
    await page.evaluate(()=>{releaseNativeCSS=true;for(const resolve of nativeCSSHeld.splice(0))resolve()});
    await child.waitForFunction(()=>getComputedStyle(document.querySelector('.held')).backgroundImage.startsWith('url("blob:'));
    await child.waitForFunction(()=>nativeResponsiveLoaded&&nativeResponsiveImage.complete);
    const result=await child.evaluate(()=>({status:sandstone_frame.native_css_status(),identity:nativeStyle.firstChild===nativeFirst}));
    assert.equal(result.identity,true);assert.equal(result.status.ready,!blocked);
    if(!blocked)for(const name of ['scan','prepare','restoreParts','apply','srcset','applySrcset'])assert.ok(result.status.calls[name]>0,name+' did not use C++');
    else assert.ok(result.status.failure);
    const requests=await page.evaluate(()=>nativeCSSRequests);
    assert.ok(requests.includes('/supported.css'));assert.ok(!requests.includes('/ignored.css'));
    assert.deepEqual(direct,[]);assert.deepEqual(errors,[]);
    return ['Native CSS '+(blocked?'compilation fallback':'scanning/preparation/restoration/assembly')+' from file://'];
  }finally{page.off('request',request);page.off('pageerror',error);}
}
