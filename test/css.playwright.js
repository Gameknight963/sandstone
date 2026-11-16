async page => {
  await page.evaluate(async () => {
    const previous=sandstone.network.session.fetch;
    globalThis.cssRequests=[];
    sandstone.network.session.fetch=async (url,options) => {
      const path=new URL(url).pathname;
      if(!path.startsWith('/css-fixture/')) return previous(url,options);
      cssRequests.push(url);
      if(path.endsWith('/theme.css')) return new Response('@import "nested.css"; @import "cycle.css"; #imported {color:rgb(21,43,65)}', {headers:{'Content-Type':'text/css'}});
      if(path.endsWith('/nested.css')) return new Response('#nested {padding-left:17px; background-image:url("image (one).svg#shape")}', {headers:{'Content-Type':'text/css'}});
      if(path.endsWith('/cycle.css')) return new Response('@import "theme.css"; #cycle {margin-left:19px}', {headers:{'Content-Type':'text/css'}});
      if(path.endsWith('/dynamic.css')) {
        await new Promise(resolve=>setTimeout(resolve,50));
        return new Response('#dynamic {color:rgb(67,89,101)}',{headers:{'Content-Type':'text/css'}});
      }
      if(path.endsWith('/missing.css')) return new Response('',{status:404});
      if(path.endsWith('/slow.css')) {
        await new Promise(resolve=>globalThis.releaseSlowCSS=resolve);
        return new Response('#dynamic {color:rgb(1,2,3)}',{headers:{'Content-Type':'text/css'}});
      }
      return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect id="shape" width="2" height="2" fill="green"/></svg>',{headers:{'Content-Type':'image/svg+xml'}});
    };
    main_frame.special_pages['https://fixture.test/css-fixture/page']=`<!doctype html>
      <style>
        @import './theme.css' layer(theme) supports(display:grid) screen;
        @import './missing.css';
        #images {background-image:image-set('./one.svg' 1x type('image/svg+xml'), url('./two.svg') 2x)}
      </style>
      <body><div id="imported">Imported</div><div id="nested">Nested</div><div id="cycle">Cycle</div>
      <div id="images">Images</div><div id="dynamic">Dynamic</div>
      <script>
        const style=document.createElement('style');
        style.textContent='@import "/css-fixture/dynamic.css"; #dynamic { background-image:url("/css-fixture/dynamic.svg") }';
        document.head.append(style);
        window.fixtureDynamicStyle=style;
      <\/script>`;
    await main_frame.navigate_to('https://fixture.test/css-fixture/page');
  });
  const deadline=Date.now()+10000;
  let result;
  while(Date.now()<deadline) {
    result=JSON.parse(await page.evaluate(()=>main_frame.eval_js(`JSON.stringify({
      imported:getComputedStyle(document.getElementById('imported')).color,
      nested:getComputedStyle(document.getElementById('nested')).paddingLeft,
      cycle:getComputedStyle(document.getElementById('cycle')).marginLeft,
      dynamic:getComputedStyle(document.getElementById('dynamic')).color,
      image:getComputedStyle(document.getElementById('nested')).backgroundImage,
      images:getComputedStyle(document.getElementById('images')).backgroundImage
    })`)));
    if(result.imported==='rgb(21, 43, 65)' && result.nested==='17px' && result.cycle==='19px' && result.dynamic==='rgb(67, 89, 101)') break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  if(result.imported!=='rgb(21, 43, 65)' || result.nested!=='17px' || result.cycle!=='19px' || result.dynamic!=='rgb(67, 89, 101)') throw new Error('CSS imports failed: '+JSON.stringify(result));
  if(!result.image.includes('blob:') || !result.image.includes('#shape') || !result.images.includes('blob:')) throw new Error('CSS images did not use local blobs: '+JSON.stringify(result));
  const requested=await page.evaluate(()=>cssRequests.map(url=>new URL(url).pathname));
  for(const name of ['theme.css','nested.css','cycle.css','dynamic.css','missing.css','image%20(one).svg','one.svg','two.svg','dynamic.svg']) {
    if(!requested.includes('/css-fixture/'+name)) throw new Error('Missing relayed CSS request: '+name+' '+JSON.stringify(requested));
  }
  if(requested.filter(path=>path.endsWith('/theme.css')).length!==1) throw new Error('CSS import cycle was fetched repeatedly');
  await page.evaluate(()=>main_frame.eval_js(`fixtureDynamicStyle.innerHTML='@import "/css-fixture/slow.css";'; true`));
  await page.waitForFunction(()=>typeof releaseSlowCSS==='function');
  await page.evaluate(()=>main_frame.eval_js(`fixtureDynamicStyle.textContent='#dynamic {color:rgb(111,112,113)}'; true`));
  await page.evaluate(()=>releaseSlowCSS());
  // Wait for the obsolete response to finish crossing the relay before checking.
  await page.evaluate(()=>main_frame.eval_js(`new Promise(resolve=>setTimeout(resolve,100))`));
  const final=await page.evaluate(()=>main_frame.eval_js(`getComputedStyle(document.getElementById('dynamic')).color`));
  if(final!=='rgb(111, 112, 113)') throw new Error('An obsolete stylesheet overwrote a later text update: '+final);
  return ['Nested CSS imports with layers/supports/media', 'CSS import cycles and failed requests', 'Escaped/quoted CSS URLs and image-set', 'Dynamic stylesheet text updates and races'];
}
