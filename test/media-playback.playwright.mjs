import assert from 'node:assert/strict';

export async function verifyMediaSources(page){return verifyMediaPlayback(page,{children:true});}

export async function verifyMediaPlayback(page,{children=false}={}){
  const origin=children?'https://media-source-playback.test':'https://media-playback.test';
  const setup=children?`
    const add=(url,type)=>{const source=document.createElement('source');source.src=url;if(type)source.type=type;source.onerror=()=>sourceErrors.push(url);audio.append(source);};
    if(window.sourcePlan==='unsupported')add('/unsupported.wav','audio/x-unsupported-sandstone');
    if(window.sourcePlan==='direct-wins')audio.src='/slow.wav';else if(!window.sourcePlan?.startsWith('parser'))add('/slow.wav');
    if(window.sourcePlan?.startsWith('fallback-')||window.sourcePlan?.startsWith('all-'))add(window.sourcePlan.includes('delayed')?'/unused.wav':'/fast.wav');
    if(window.sourcePlan==='unused'||window.sourcePlan==='direct-wins')add('/unused.wav');
  `:"audio.src='/slow.wav';";
  const html=`<!doctype html><body><button id="start">Start</button><audio id="audio" muted></audio><script>
    window.results=[];window.events=[];window.captured=[];window.sourceErrors=[];window.sourceCaptured=[];const audio=document.getElementById('audio');
    window.requestPlay=()=>{const index=results.length;results.push('pending');audio.play().then(()=>results[index]='fulfilled',error=>results[index]=error.name);};
    for(const type of ['play','playing','pause','abort','error','loadstart','emptied'])audio.addEventListener(type,()=>events.push(type));
    for(const type of ['play','playing','abort','loadstart','emptied'])window.addEventListener(type,event=>{if(event.target===audio)captured.push(type)},true);
    window.addEventListener('error',event=>{if(event.target instanceof HTMLSourceElement)sourceCaptured.push(event.target.getAttribute('src'));},true);
    if(audio.autoplay){results.push('pending');audio.addEventListener('playing',()=>results[0]='fulfilled',{once:true});}
    document.getElementById('start').onclick=()=>{${setup}requestPlay();};
  </script>`;
  const wav=new Uint8Array(160044),view=new DataView(wav.buffer);
  const word=(offset,value)=>wav.set(new TextEncoder().encode(value),offset);
  word(0,'RIFF');view.setUint32(4,160036,true);word(8,'WAVE');word(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,8000,true);view.setUint32(28,16000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
  word(36,'data');view.setUint32(40,160000,true);
  const native=await page.context().newPage();
  let release,releaseUnused,started,gate,unusedGate,request,failure;
  await native.route(origin+'/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/page')return route.fulfill({contentType:'text/html',body:failure?.startsWith('parser')?html.replace('<audio id="audio" muted></audio>','<audio id="audio" muted'+(failure==='parser-autoplay'?' autoplay':'')+'><source src="/slow.wav"></audio>'):html});
    if(path==='/slow.wav'){started();await gate;}
    if(path==='/unused.wav')await unusedGate;
    const failed=path==='/slow.wav'||failure?.startsWith('all-')&&path==='/fast.wav';
    await route.fulfill({status:failed&&failure?.endsWith('http')?404:200,contentType:'audio/wav',body:failed&&failure?.endsWith('decode')?Buffer.from('invalid audio'):Buffer.from(wav)});
  });
  await page.evaluate(({origin,html,bytes})=>{
    const previous=sandstone.network.session.fetch;
    sandstone.network.session.fetch=async(url,...args)=>{
      if(new URL(url).origin!==origin)return previous.call(sandstone.network.session,url,...args);
      const path=new URL(url).pathname;
      if(path==='/page'){
        const mode=globalThis.mediaPlaybackFailure;
        return new Response(mode?.startsWith('parser')?html.replace('<audio id="audio" muted></audio>','<audio id="audio" muted'+(mode==='parser-autoplay'?' autoplay':'')+'><source src="/slow.wav"></audio>'):html,{headers:{'Content-Type':'text/html'}});
      }
      if(path==='/slow.wav'){
        globalThis.mediaPlaybackStarted=true;
        await globalThis.mediaPlaybackGate;
      }
      if(path==='/unused.wav')await globalThis.mediaPlaybackUnusedGate;
      const mode=globalThis.mediaPlaybackFailure,failed=path==='/slow.wav'||mode?.startsWith('all-')&&path==='/fast.wav';
      return new Response(failed&&mode?.endsWith('decode')?'invalid audio':Uint8Array.from(bytes),{
        status:failed&&mode?.endsWith('http')?404:200,headers:{'Content-Type':'audio/wav'}});
    };
  },{origin,html,bytes:[...wav]});
  const direct=[],observe=request=>{if(/^https?:/.test(request.url()))direct.push(request.url());};
  page.on('request',observe);
  const read=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js('JSON.stringify('+source+')'),source).then(JSON.parse):native.evaluate(source=>eval(source),source);
  let activeCase;
  const until=async(proxy,source)=>{
    const deadline=Date.now()+5000;
    while(!await read(proxy,source)){
      if(Date.now()>deadline)throw new Error('Media playback timed out: '+activeCase+' '+(proxy?'proxy':'native')+' '+source+' '+JSON.stringify(await read(proxy,'({results,events,paused:audio.paused,muted:audio.muted,autoplay:audio.autoplay,ready:audio.readyState,error:audio.error?.code})')));
      await page.waitForTimeout(20);
    }
  };
  const snapshot='({results,paused:audio.paused,ready:audio.readyState,network:audio.networkState,error:audio.error?.code||null,src:audio.src,current:audio.currentSrc,attribute:audio.getAttribute("src")})';
  const cases=[
    ['success',''],
    ['unmuted playback','','unmuted'],
    ['detached playback','','detached'],
    ['multiple calls','requestPlay()'],
    ['pause','audio.pause()'],
    ['load','audio.load()'],
    ['load and replay','audio.load();requestPlay()'],
    ['replacement','audio.src="/fast.wav"'],
    ['replacement and replay','audio.src="/fast.wav";requestPlay()'],
    ['same URL replacement','audio.src="/slow.wav"'],
    ['removal','audio.removeAttribute("src");audio.load()'],
    ['pause and replay','audio.pause();requestPlay()'],
    ['pause then loaded replay','audio.pause()'],
    ...children?[
      ['source replacement and load','audio.firstElementChild.src="/fast.wav";audio.load()'],
      ['source replacement and replay','audio.firstElementChild.src="/fast.wav";audio.load();requestPlay()'],
      ['parser source','','parser'],
      ['parser autoplay','','parser-autoplay'],
      ['HTTP fallback','','fallback-http'],
      ['HTTP fallback with overridden src getter','Object.defineProperty(audio.firstElementChild,"src",{configurable:true,get(){throw new Error("authored src getter")}})','fallback-http'],
      ['delayed fallback','','fallback-delayed-http'],
      ['decode fallback','','fallback-decode'],
      ['all HTTP sources fail','','all-http'],
      ['all sources fail decoding','','all-decode'],
      ['unused stalled fallback','','unused'],
      ['unsupported source type','','unsupported'],
      ['unsupported source reload','audio.load();requestPlay()','unsupported'],
      ['direct source wins','','direct-wins']
    ]:[
      ['HTTP failure','', 'http'],
      ['decode failure','', 'decode']
    ]
  ];
  const passed=[];
  try{
    for(const [name,action,mode] of cases){
      activeCase=name;
      const outcomes=[];
      for(const proxy of [false,true]){
        failure=mode;gate=new Promise(resolve=>release=resolve);request=new Promise(resolve=>started=resolve);
        unusedGate=new Promise(resolve=>releaseUnused=resolve);
        if(proxy){
          await page.evaluate(mode=>{
            globalThis.mediaPlaybackStarted=false;globalThis.mediaPlaybackFailure=mode;
            globalThis.mediaPlaybackGate=new Promise(resolve=>globalThis.releaseMediaPlayback=resolve);
            globalThis.mediaPlaybackUnusedGate=new Promise(resolve=>globalThis.releaseUnusedMediaPlayback=resolve);
          },mode);
          await page.evaluate(url=>main_frame.navigate_to(url),origin+'/page');
        }else await native.goto(origin+'/page',{waitUntil:mode?.startsWith('parser')?'domcontentloaded':'load'});
        if(children)await read(proxy,'(()=>{window.sourcePlan='+JSON.stringify(mode||'single')+';return true})()');
        if(mode==='unmuted')await read(proxy,'(()=>{audio.muted=false;return true})()');
        if(mode==='detached')await read(proxy,'(()=>{audio.remove();return true})()');
        const surface=proxy?page.frameLocator('iframe[frame-id]'):native;
        if(mode!=='parser-autoplay')await surface.locator('#start').click();
        if(proxy)await page.waitForFunction(()=>mediaPlaybackStarted);else await request;
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const hasSrc=!children||mode==='direct-wins';
        assert.deepEqual(await read(proxy,snapshot),{results:['pending'],paused:mode==='parser-autoplay',ready:0,network:2,error:null,src:hasSrc?origin+'/slow.wav':'',current:origin+'/slow.wav',attribute:hasSrc?'/slow.wav':null},name+' pending '+proxy);
        if(action)await read(proxy,'(()=>{'+action+';return true})()');
        // Let explicit cancellation settle before installing the response.
        if(action&&!['multiple calls','pause and replay','HTTP fallback with overridden src getter'].includes(name))await until(proxy,'results[0]!=="pending"');
        if(proxy)await page.evaluate(()=>releaseMediaPlayback());else release();
        if(mode==='fallback-delayed-http'){
          await until(proxy,'sourceErrors.length===1&&audio.currentSrc==='+JSON.stringify(origin+'/unused.wav'));
          assert.deepEqual(await read(proxy,'({results,paused:audio.paused,ready:audio.readyState,network:audio.networkState})'),
            {results:['pending'],paused:false,ready:0,network:2},name+' pending fallback '+proxy);
          if(proxy)await page.evaluate(()=>releaseUnusedMediaPlayback());else releaseUnused();
        }
        if(name==='pause then loaded replay'){
          await until(proxy,'audio.readyState===4');
          await read(proxy,'(()=>{requestPlay();return true})()');
        }
        if(mode?.startsWith('all-')){
          await until(proxy,'sourceErrors.length===2');
          assert.deepEqual(await read(proxy,'({results,paused:audio.paused,ready:audio.readyState,network:audio.networkState,error:audio.error?.code||null})'),
            {results:['pending'],paused:false,ready:0,network:3,error:null},name+' exhausted sources '+proxy);
          await read(proxy,'(()=>{audio.pause();return true})()');
        }
        await until(proxy,'results.every(value=>value!=="pending")');
        if(mode?.startsWith('fallback-'))await until(proxy,'sourceErrors.length===1');
        if(['success','unmuted playback','detached playback','multiple calls','pause and replay'].includes(name))await until(proxy,'audio.readyState===4');
        if(mode==='unused'||mode==='direct-wins'){
          await read(proxy,'(()=>{window.unusedPhysical=Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype,"src").get.call(audio.lastElementChild);return true})()');
          if(proxy){
            await page.evaluate(()=>releaseUnusedMediaPlayback());
            await until(proxy,'Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype,"src").get.call(audio.lastElementChild)!==unusedPhysical');
          }else releaseUnused();
          await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        }
        const result=await read(proxy,'({results,events,captured,sourceErrors,sourceCaptured,paused:audio.paused,error:audio.error?.code||null,current:audio.currentSrc})');
        outcomes.push(result);
        // Paused media may finish loading asynchronously; do not let that leak
        // into the next test's request gate.
        await read(proxy,'(()=>{audio.pause();return true})()');
        releaseUnused();if(proxy)await page.evaluate(()=>releaseUnusedMediaPlayback());
      }
      assert.deepEqual(outcomes[1].results,outcomes[0].results,name+' promise parity');
      assert.equal(outcomes[1].paused,outcomes[0].paused,name+' paused parity');
      assert.equal(outcomes[1].error,outcomes[0].error,name+' error parity');
      assert.equal(outcomes[1].current,outcomes[0].current,name+' currentSrc parity');
      assert.deepEqual(outcomes[1].sourceErrors,outcomes[0].sourceErrors,name+' source error parity');
      assert.deepEqual(outcomes[1].sourceCaptured,outcomes[0].sourceCaptured,name+' captured source error parity');
      if(!action&&['fallback-http','fallback-delayed-http','fallback-decode','unused','unsupported','direct-wins'].includes(mode))assert.deepEqual(outcomes[0].results,['fulfilled'],name+' native playback');
      if(['success','unmuted playback','detached playback','multiple calls','pause then loaded replay','parser source','parser autoplay','HTTP fallback','delayed fallback','decode fallback','unused stalled fallback','unsupported source type','direct source wins'].includes(name)){
        assert.deepEqual(outcomes[1].events,outcomes[0].events,name+' event parity');
        assert.deepEqual(outcomes[1].captured,outcomes[0].captured,name+' captured event parity');
      }
      passed.push((children?'Child-source playback: ':'Pending media playback: ')+name);
    }
    assert.deepEqual(direct,[],'Media playback bypassed the relay');
    return passed;
  }finally{
    release?.();releaseUnused?.();page.off('request',observe);await native.close();
  }
}
