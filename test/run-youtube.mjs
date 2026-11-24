// Opt-in live-site diagnostic. Public relay throughput is deliberately not a
// pass/fail metric. Use --public for the example's public relay, --native for
// a native-browser baseline, or --watch-only to isolate playback from search.
import assert from 'node:assert/strict';
import {firefox,chromium} from 'playwright-core';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {create_relay_server} from '../example/http.mjs';
import {server as wisp,logging} from '../example/node_modules/@mercuryworkshop/wisp-js/src/entrypoints/server.mjs';
import {track_client_sockets} from './client-sockets.mjs';

const args=new Set(process.argv.slice(2)),native=args.has('--native');
const timeout=Number(process.env.YOUTUBE_TIMEOUT_MS||180000),seek=Number(process.env.YOUTUBE_SEEK_SECONDS||5),videoID='aqz-KE-bpKQ';
const watch='https://www.youtube.com/watch?v='+videoID;
const start=args.has('--watch-only')?watch:'https://www.youtube.com/results?search_query=Big+Buck+Bunny+60fps+4K+Blender';
const closeSockets=track_client_sockets(),sockets=new Set(),server=create_relay_server((request,response)=>{response.writeHead(404);response.end();});
server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
server.on('upgrade',(request,socket,head)=>wisp.routeRequest(request,socket,head));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
wisp.options.port_whitelist=[80,443];wisp.options.allow_loopback_ips=false;logging.set_level(logging.WARN);
const engine=args.has('--chromium')?chromium:firefox;
const browser=await engine.launch({headless:true});
const context=await browser.newContext(),page=await context.newPage(),errors=[],direct=[],directSources=[];
const relay=process.env.YOUTUBE_RELAY||(args.has('--public')?'wss://wisp.mercurywork.shop/':'ws://127.0.0.1:'+server.address().port+'/');
let stage='opening',result;
const phase=async(name,operation)=>{
  stage=name;console.log(JSON.stringify({stage}));let timer;
  try{return await Promise.race([operation(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(name+' timed out')),timeout);})]);}
  finally{clearTimeout(timer);}
};
const evaluate=source=>native?page.evaluate(source=>eval(source),source):page.evaluate(source=>main_frame.eval_js(source),source);
const read=async source=>JSON.parse(await evaluate('JSON.stringify('+source+')'));
const until=async predicate=>{while(!await predicate())await new Promise(resolve=>setTimeout(resolve,300));};
const state=`(()=>{const video=document.querySelector('video');return {url:location.href,title:document.title,text:document.body?.innerText.slice(0,500),video:video&&{time:video.currentTime,duration:Number.isFinite(video.duration)?video.duration:null,paused:video.paused,ready:video.readyState,width:video.videoWidth,height:video.videoHeight,frames:video.getVideoPlaybackQuality().totalVideoFrames,error:video.error&&{code:video.error.code,message:video.error.message}}};})()`;
let inspecting=false;
const progress=setInterval(async()=>{
  if(inspecting)return;inspecting=true;
  try{
    const snapshot=await Promise.race([read(state),new Promise(resolve=>setTimeout(()=>resolve(null),2000))]);
    console.log(JSON.stringify({stage,waiting:true,state:snapshot}));
  }catch{console.log(JSON.stringify({stage,waiting:true}));}finally{inspecting=false;}
},15000);
const watchdog=setTimeout(()=>browser.close().catch(()=>{}),timeout*5);
page.on('pageerror',error=>errors.push(error.stack||error.message));
if(!native){page.on('request',request=>{
  if(!/^https?:/.test(request.url()))return;
  direct.push(request.url().split('?')[0]);
  directSources.push({url:request.url().split('?')[0],type:request.resourceType(),frame:request.frame().url().slice(0,120)});
});await page.route(/^https?:/,route=>route.abort('blockedbyclient'));}
try{
  await phase('opening',async()=>{
    if(native){await page.goto(start,{waitUntil:'domcontentloaded',timeout});return;}
    await page.goto(pathToFileURL(fileURLToPath(new URL('../example/bundled.html',import.meta.url))).href);
    await page.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await page.evaluate(relay=>{
      sandstone.network.set_websocket(relay);globalThis.youtubeRequests=[];
      const session=sandstone.network.session,fetch=session.fetch;
      session.fetch=async function(url,...args){
        const parsed=new URL(url),record={host:parsed.hostname,path:parsed.pathname,status:null,start:Date.now()};youtubeRequests.push(record);
        try{const response=await fetch.call(this,url,...args);record.status=response.status;record.type=response.headers.get('content-type');return response;}
        catch(error){record.error=String(error);throw error;}
      };
    },relay);
    await page.evaluate(url=>main_frame.navigate_to(url),start);
  });
  const surface=native?page:page.frameLocator('iframe[frame-id]');
  if(!args.has('--watch-only'))await phase('search result navigation',async()=>{
    const link=surface.locator('a[href*="/watch?v='+videoID+'"]:visible').first();
    await link.waitFor({timeout});await link.click({timeout});
    await until(()=>read('location.pathname==="/watch"&&new URLSearchParams(location.search).get("v")==='+JSON.stringify(videoID)));
  });
  await phase('starting playback',async()=>{
    await surface.locator('video').waitFor({state:'attached',timeout});
    await evaluate('document.querySelector("video").muted=true;true');
    await until(async()=>{
      const value=await read(state);if(value.video?.error)throw new Error('Media error: '+value.video.error.message);
      if(value.text?.includes('Sign in to confirm')){const error=new Error('YouTube requires sign-in before sending video through this relay');error.externalBlock=true;throw error;}
      if(value.video?.time>.25&&!value.video.paused&&value.video.width>0&&value.video.frames>0)return true;
      // The player can have a pending play request while the native video is
      // still paused for buffering. Follow the button's action rather than
      // accidentally toggling that pending request back to Pause.
      const button=surface.locator('.ytp-play-button');
      const label=await button.getAttribute('aria-label')||await button.getAttribute('title')||'';
      if(/^Play\b/.test(label))await button.click({timeout});
      return false;
    });
  });
  const playing=await read(state);
  await phase('pausing',async()=>{await surface.locator('.ytp-play-button').click({timeout});await until(()=>read('document.querySelector("video").paused'));});
  const target=Math.min(seek,playing.video.duration/2);
  await phase('seeking and resuming',async()=>{
    await evaluate('document.querySelector("video").currentTime='+target+';true');
    await surface.locator('.ytp-play-button').click({timeout});
    await until(async()=>{const value=await read(state);if(value.video?.error)throw new Error('Media error: '+value.video.error.message);return value.video.time>target+.25&&!value.video.paused&&value.video.frames>0;});
  });
  const resumed=await read(state);assert.deepEqual(direct,[],'YouTube attempted direct HTTP outside the relay');
  result={status:'passed',engine:engine.name(),native,relay:native?null:args.has('--public')?'public':'configured/local',searched:!args.has('--watch-only'),played:true,paused:true,seekTarget:target,seeked:true,resumed:true,video:resumed.video,scriptErrors:errors};
}catch(error){
  result={status:error.externalBlock?'blocked':'failed',stage,error:error.message,engine:engine.name(),native,scriptErrors:errors,directHTTP:direct,directSources};
  try{result.state=await Promise.race([read(state),new Promise(resolve=>setTimeout(()=>resolve({unavailable:true}),2000))]);}catch{}
  process.exitCode=1;
}finally{
  clearInterval(progress);clearTimeout(watchdog);
  if(!native)try{result.requests=await Promise.race([page.evaluate(()=>youtubeRequests),new Promise(resolve=>setTimeout(()=>resolve([]),2000))]);}catch{}
  if(direct.length)try{result.mediaArtwork=await read('navigator.mediaSession?.metadata?.artwork');}catch{}
  await writeFile(new URL('../.temp/youtube-'+(native?'native':args.has('--public')?'public':'local')+'-seek-'+seek+'-playback.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));await browser.close();for(const socket of sockets)socket.destroy();closeSockets();await new Promise(resolve=>server.close(resolve));
}
