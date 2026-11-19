import assert from 'node:assert/strict';

export async function verifyMediaPlayback(page){
  const origin='https://media-playback.test';
  const html=`<!doctype html><body><button id="start">Start</button><audio id="audio" muted></audio><script>
    window.results=[];window.events=[];window.captured=[];const audio=document.getElementById('audio');
    window.requestPlay=()=>{const index=results.length;results.push('pending');audio.play().then(()=>results[index]='fulfilled',error=>results[index]=error.name);};
    for(const type of ['play','playing','pause','abort','error','loadstart','emptied'])audio.addEventListener(type,()=>events.push(type));
    for(const type of ['play','playing','abort','loadstart','emptied'])window.addEventListener(type,event=>{if(event.target===audio)captured.push(type)},true);
    document.getElementById('start').onclick=()=>{audio.src='/slow.wav';requestPlay();};
  </script>`;
  const wav=new Uint8Array(160044),view=new DataView(wav.buffer);
  const word=(offset,value)=>wav.set(new TextEncoder().encode(value),offset);
  word(0,'RIFF');view.setUint32(4,160036,true);word(8,'WAVE');word(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,8000,true);view.setUint32(28,16000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
  word(36,'data');view.setUint32(40,160000,true);
  const native=await page.context().newPage();
  let release,started,gate,request,failure;
  await native.route(origin+'/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/page')return route.fulfill({contentType:'text/html',body:html});
    if(path==='/slow.wav'){started();await gate;}
    await route.fulfill({status:failure==='http'?404:200,contentType:'audio/wav',body:failure==='decode'?Buffer.from('invalid audio'):Buffer.from(wav)});
  });
  await page.evaluate(({origin,html,bytes})=>{
    const previous=sandstone.network.session.fetch;
    sandstone.network.session.fetch=async(url,...args)=>{
      if(new URL(url).origin!==origin)return previous.call(sandstone.network.session,url,...args);
      const path=new URL(url).pathname;
      if(path==='/page')return new Response(html,{headers:{'Content-Type':'text/html'}});
      if(path==='/slow.wav'){
        globalThis.mediaPlaybackStarted=true;
        await globalThis.mediaPlaybackGate;
      }
      return new Response(globalThis.mediaPlaybackFailure==='decode'?'invalid audio':Uint8Array.from(bytes),{
        status:globalThis.mediaPlaybackFailure==='http'?404:200,headers:{'Content-Type':'audio/wav'}});
    };
  },{origin,html,bytes:[...wav]});
  const direct=[],observe=request=>{if(/^https?:/.test(request.url()))direct.push(request.url());};
  page.on('request',observe);
  const read=(proxy,source)=>proxy?page.evaluate(source=>main_frame.eval_js('JSON.stringify('+source+')'),source).then(JSON.parse):native.evaluate(source=>eval(source),source);
  const until=async(proxy,source)=>{
    const deadline=Date.now()+5000;
    while(!await read(proxy,source)){
      if(Date.now()>deadline)throw new Error('Media playback timed out: '+source+' '+JSON.stringify(await read(proxy,'({results,events,paused:audio.paused,ready:audio.readyState,error:audio.error?.code})')));
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
    ['HTTP failure','', 'http'],
    ['decode failure','', 'decode']
  ];
  const passed=[];
  try{
    for(const [name,action,mode] of cases){
      const outcomes=[];
      for(const proxy of [false,true]){
        failure=mode;gate=new Promise(resolve=>release=resolve);request=new Promise(resolve=>started=resolve);
        if(proxy){
          await page.evaluate(mode=>{
            globalThis.mediaPlaybackStarted=false;globalThis.mediaPlaybackFailure=mode;
            globalThis.mediaPlaybackGate=new Promise(resolve=>globalThis.releaseMediaPlayback=resolve);
          },mode);
          await page.evaluate(url=>main_frame.navigate_to(url),origin+'/page');
        }else await native.goto(origin+'/page');
        if(mode==='unmuted')await read(proxy,'(()=>{audio.muted=false;return true})()');
        if(mode==='detached')await read(proxy,'(()=>{audio.remove();return true})()');
        const surface=proxy?page.frameLocator('iframe[frame-id]'):native;
        await surface.locator('#start').click();
        if(proxy)await page.waitForFunction(()=>mediaPlaybackStarted);else await request;
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        assert.deepEqual(await read(proxy,snapshot),{results:['pending'],paused:false,ready:0,network:2,error:null,src:origin+'/slow.wav',current:origin+'/slow.wav',attribute:'/slow.wav'},name+' pending '+proxy);
        if(action)await read(proxy,'(()=>{'+action+';return true})()');
        // Let explicit cancellation settle before installing the response.
        if(action&&!['multiple calls','pause and replay'].includes(name))await until(proxy,'results[0]!=="pending"');
        if(proxy)await page.evaluate(()=>releaseMediaPlayback());else release();
        if(name==='pause then loaded replay'){
          await until(proxy,'audio.readyState===4');
          await read(proxy,'(()=>{requestPlay();return true})()');
        }
        await until(proxy,'results.every(value=>value!=="pending")');
        if(['success','unmuted playback','detached playback','multiple calls','pause and replay'].includes(name))await until(proxy,'audio.readyState===4');
        const result=await read(proxy,'({results,events,captured,paused:audio.paused,error:audio.error?.code||null,current:audio.currentSrc})');
        outcomes.push(result);
        // Paused media may finish loading asynchronously; do not let that leak
        // into the next test's request gate.
        await read(proxy,'(()=>{audio.pause();return true})()');
      }
      assert.deepEqual(outcomes[1].results,outcomes[0].results,name+' promise parity');
      assert.equal(outcomes[1].paused,outcomes[0].paused,name+' paused parity');
      assert.equal(outcomes[1].error,outcomes[0].error,name+' error parity');
      assert.equal(outcomes[1].current,outcomes[0].current,name+' currentSrc parity');
      if(['success','unmuted playback','detached playback','multiple calls','pause then loaded replay'].includes(name)){
        assert.deepEqual(outcomes[1].events,outcomes[0].events,name+' event parity');
        assert.deepEqual(outcomes[1].captured,outcomes[0].captured,name+' captured event parity');
      }
      passed.push('Pending media playback: '+name);
    }
    assert.deepEqual(direct,[],'Media playback bypassed the relay');
    return passed;
  }finally{
    release?.();page.off('request',observe);await native.close();
  }
}
