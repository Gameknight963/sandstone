async page => {
  const evaluate=source=>page.evaluate(source=>main_frame.eval_js(source),source);
  const read=async source=>JSON.parse(await evaluate(`JSON.stringify(${source})`));
  const until=async source=>{
    const deadline=Date.now()+10000;
    while(!await evaluate(source)) {
      if(Date.now()>deadline) throw new Error('Media condition timed out: '+source+' '+await evaluate('document.body.innerHTML'));
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  };
  await page.setViewportSize({width:1280,height:900});
  await page.evaluate(async ()=>{
    const previous=sandstone.network.session.fetch;
    globalThis.mediaRequests=[];
    globalThis.mediaSlowFinished=false;
    sandstone.network.session.fetch=async (url,options)=>{
      const path=new URL(url).pathname;
      if(!path.startsWith('/media-fixture/')) return previous(url,options);
      mediaRequests.push(url);
      if(path.endsWith('/missing.svg')) return new Response('',{status:404});
      if(path.endsWith('/slow.svg')) {
        await new Promise(resolve=>globalThis.releaseSlowImage=resolve);
        mediaSlowFinished=true;
      }
      if(path.endsWith('.vtt')) return new Response('WEBVTT\n\n00:00.000 --> 00:01.000\nCaption\n',{headers:{'Content-Type':'text/vtt'}});
      if(path.endsWith('.wav')) {
        const bytes=new Uint8Array(1644), view=new DataView(bytes.buffer);
        const word=(offset,value)=>bytes.set(new TextEncoder().encode(value),offset);
        word(0,'RIFF'); view.setUint32(4,1636,true); word(8,'WAVE'); word(12,'fmt ');
        view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
        view.setUint32(24,8000,true); view.setUint32(28,16000,true); view.setUint16(32,2,true); view.setUint16(34,16,true);
        word(36,'data'); view.setUint32(40,1600,true);
        return new Response(bytes,{headers:{'Content-Type':'audio/wav'}});
      }
      return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="green"/></svg>',{headers:{'Content-Type':'image/svg+xml'}});
    };
    main_frame.special_pages['https://fixture.test/media-fixture/page']=`<!doctype html><base href="/media-fixture/">
      <body>
      <img id="responsive" srcset="small.svg 400w, large.svg 1600w" sizes="400px">
      <picture><source id="artSource" media="(min-width:900px)" srcset="wide.svg 1x"><img id="art" src="fallback.svg"></picture>
      <img id="mixed" srcset="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='2'%20height='2'%3E%3C/svg%3E 1x, density.svg 2x">
      <video id="movie" poster="poster.svg"><source src="one.wav" type="audio/unsupported"><source src="two.wav" type="audio/wav"><track src="captions.vtt" kind="captions" default><span id="fallbackContent">Fallback</span></video>
      <audio id="sound"><source src="sound.wav"></audio>
      <script>
        window.detached=document.createElement('img');
        detached.src='detached.svg';
        window.constructed=new Image(); constructed.src='constructor.svg';
        window.namespaced=document.createElementNS('http://www.w3.org/1999/xhtml','img');
        namespaced.setAttributeNS(null,'src','namespace.svg');
      <\/script>`;
    await main_frame.navigate_to('https://fixture.test/media-fixture/page');
  });
  await until(`document.getElementById('responsive').currentSrc.endsWith('/small.svg') &&
    document.getElementById('responsive').naturalWidth>0 && document.getElementById('art').currentSrc.endsWith('/wide.svg') &&
    detached.complete && detached.naturalWidth>0 && constructed.naturalWidth>0 && namespaced.naturalWidth>0`);
  await until(`document.getElementById('movie').readyState>=1 && document.getElementById('sound').readyState>=1 &&
    document.querySelector('track').readyState===2`);
  if(!await evaluate(`document.getElementById('movie').currentSrc.endsWith('/two.wav') && document.querySelector('track').track.cues.length===1`)) throw new Error('Native media source selection or captions failed');
  const reflected=await read(`({srcset:document.getElementById('responsive').srcset,
    attr:document.getElementById('responsive').getAttribute('SRCSET'),
    detached:detached.src,attrDetached:detached.getAttribute('src'),
    ns:namespaced.getAttributeNS(null,'src'),poster:document.getElementById('movie').poster,
    sources:document.getElementById('movie').querySelectorAll('source').length,
    tracks:document.getElementById('movie').querySelectorAll('track').length,
    fallback:Boolean(document.getElementById('fallbackContent'))})`);
  const expected={srcset:'small.svg 400w, large.svg 1600w',attr:'small.svg 400w, large.svg 1600w',
    detached:'https://fixture.test/media-fixture/detached.svg',attrDetached:'detached.svg',ns:'namespace.svg',
    poster:'https://fixture.test/media-fixture/poster.svg',sources:2,tracks:1,fallback:true};
  if(JSON.stringify(reflected)!==JSON.stringify(expected)) throw new Error('Media URL reflection failed: '+JSON.stringify(reflected));
  await evaluate(`document.getElementById('responsive').sizes='1600px'; true`);
  await until(`document.getElementById('responsive').currentSrc.endsWith('/large.svg')`);
  await page.setViewportSize({width:500,height:900});
  await until(`document.getElementById('art').currentSrc.endsWith('/fallback.svg')`);
  await evaluate(`document.getElementById('responsive').setAttribute('SRCSET','changed.svg 1x'); true`);
  await until(`document.getElementById('responsive').currentSrc.endsWith('/changed.svg')`);
  await evaluate(`detached.src='slow.svg'; true`);
  if(!await evaluate(`detached.hasAttribute('src') && detached.getAttribute('src')==='slow.svg'`)) throw new Error('Pending media attributes were not reflected');
  await page.waitForFunction(()=>typeof releaseSlowImage==='function');
  await evaluate(`detached.src='latest.svg'; true`);
  await until(`detached.currentSrc.endsWith('/latest.svg') && detached.naturalWidth>0`);
  await page.evaluate(()=>releaseSlowImage());
  await page.waitForFunction(()=>mediaSlowFinished);
  await evaluate('new Promise(resolve=>setTimeout(resolve,100))');
  if(!await evaluate(`detached.currentSrc.endsWith('/latest.svg')`)) throw new Error('A stale image response replaced the latest src');
  await evaluate(`namespaced.removeAttributeNS(null,'src'); true`);
  if(await read(`namespaced.getAttribute('src')`)!==null) throw new Error('Removing a virtualized media source failed');
  if(await evaluate(`namespaced.hasAttributeNS(null,'src')`)) throw new Error('A removed media attribute still exists');
  const failure=await evaluate(`new Promise(resolve=>{
    const image=new Image();
    image.onerror=()=>resolve(image.src);
    image.src='missing.svg';
  })`);
  if(failure!=='https://fixture.test/media-fixture/missing.svg') throw new Error('A failed relayed image did not dispatch its error event');
  const requests=await page.evaluate(()=>mediaRequests.map(url=>new URL(url).pathname));
  for(const file of ['small.svg','large.svg','wide.svg','fallback.svg','density.svg','poster.svg','one.wav','two.wav','sound.wav','captions.vtt','detached.svg','constructor.svg','namespace.svg','changed.svg','slow.svg','latest.svg','missing.svg']) {
    if(!requests.includes('/media-fixture/'+file)) throw new Error('Media did not use the relay: '+file+' '+JSON.stringify(requests));
  }
  await page.setViewportSize({width:1280,height:900});
  return ['Responsive srcset/sizes and picture media selection','Detached images and Image constructors through the relay',
    'Media source/track/fallback preservation and video posters','Media URL reflection and stale-request cancellation'];
}
