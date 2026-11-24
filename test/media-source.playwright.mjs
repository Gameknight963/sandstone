import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// mse.webm is a locally generated 64x48 VP8 clip (alternating solid colors).
// Keep decoding and seeking checks independent of external media servers.
export async function verifyMediaSource(page){
  const bytes=[...await readFile(new URL('./fixtures/mse.webm',import.meta.url))];
  const fixture=await page.context().newPage(),native=await page.context().newPage();
  const url='https://media-source.test/player',html='<!doctype html><body>MediaSource fixture';
  const errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));
  fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
  const run=async({bytes,method})=>{
    const video=document.createElement('video'),source=new MediaSource(),url=URL.createObjectURL(source),errors=[];
    video.muted=true;document.body.append(video);
    video.addEventListener('error',()=>errors.push(video.error?.message||'Media error'));
    const until=async predicate=>{const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw new Error('MediaSource playback timed out: '+JSON.stringify({errors,ready:source.readyState,time:video.currentTime}));await new Promise(resolve=>setTimeout(resolve,20));}};
    try{
      const opened=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('MediaSource attachment timed out')),5000);
        source.addEventListener('sourceopen',()=>{clearTimeout(timer);resolve();},{once:true});
        video.addEventListener('error',()=>{clearTimeout(timer);reject(new Error(video.error?.message||'MediaSource failed'));},{once:true});
      });
      if(method==='property')video.src=url;
      else if(method==='attribute')video.setAttribute('src',url);
      else{video.setAttribute('src','');video.getAttributeNode('src').value=url;}
      await opened;
      if(video.error)throw new Error(video.error.message);
      const buffer=source.addSourceBuffer('video/webm; codecs="vp8"');
      await new Promise((resolve,reject)=>{buffer.addEventListener('updateend',resolve,{once:true});buffer.addEventListener('error',()=>reject(new Error('SourceBuffer append failed')),{once:true});buffer.appendBuffer(new Uint8Array(bytes));});
      source.endOfStream();await video.play();
      await until(()=>video.currentTime>.15&&video.videoWidth>0);
      video.pause();video.currentTime=.6;
      await until(()=>!video.seeking&&video.currentTime>=.6);
      await video.play();await until(()=>video.currentTime>.75);video.pause();
      return {width:video.videoWidth,height:video.videoHeight,played:true,seeked:true,resumed:true,errors,attribute:video.getAttribute('src')===url};
    }finally{video.remove();URL.revokeObjectURL(url);}
  };
  try{
    await native.route(url,route=>route.fulfill({contentType:'text/html',body:html}));await native.goto(url);
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.route(/^https?:/,route=>route.abort('blockedbyclient'));
    await fixture.evaluate(async({url,html})=>{
      sandstone.network.session.fetch=async url=>new URL(url).pathname.endsWith('.svg')?new Response('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',{headers:{'content-type':'image/svg+xml'}}):new Response(null,{status:204});
      main_frame.special_pages[url]=html;await main_frame.navigate_to(url);
    },{url,html});
    await fixture.evaluate(()=>main_frame.eval_js(`(async()=>{
      const image=document.createElement('img'),video=document.createElement('video');
      const loaded=new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('Relayed image failed'));});
      image.src='https://media-source.test/image.svg';video.poster='https://media-source.test/poster.svg';document.body.append(image,video);await loaded;return true;
    })()`));
    for(const method of ['property','attribute','attribute-node']){
      const expected=await native.evaluate(run,{bytes,method});
      const actual=JSON.parse(await fixture.evaluate(source=>main_frame.eval_js(source),'(async()=>JSON.stringify(await ('+run.toString()+')('+JSON.stringify({bytes,method})+')))()'));
      assert.deepEqual(actual,expected,method);assert.deepEqual(actual.errors,[]);assert.equal(actual.width,64);
    }
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['MediaSource URLs attach once and support decoding, playback, seeking and resuming through property and attribute assignments','Hidden attribute mirrors cannot load remote images or posters outside the relay'];
  }finally{await fixture.close();await native.close();}
}
