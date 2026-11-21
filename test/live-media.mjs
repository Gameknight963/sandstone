export const mediaSites=['hls','hls-aes'].map(id=>({id,url:'https://hlsjs.video-dev.org/demo/',timeout:60000,editor:true}));

export async function interactMedia(page,proxy,site,{surface,read,wait}){
  await wait(page,proxy,'!!document.querySelector("video")');
  if(site.id==='hls-aes')await surface.locator('#streamSelect').selectOption('oceansAES');
  await read(page,proxy,'(document.querySelector("video").muted=true)');
  await surface.getByRole('button',{name:'Play',exact:true}).click();
  await wait(page,proxy,'(()=>{const v=document.querySelector("video");return v.currentTime>.2&&v.videoWidth>0&&v.getVideoPlaybackQuality().totalVideoFrames>0})()');
  if(site.id==='hls-aes')await wait(page,proxy,'hls.levels.some(level=>level.details?.fragments.some(fragment=>fragment.decryptdata?.method==="AES-128"))');
  await surface.locator('#seek_pos').fill('12');
  await surface.getByRole('button',{name:'Seek to',exact:true}).click();
  await wait(page,proxy,'document.querySelector("video").currentTime>=12');
  await surface.getByRole('button',{name:'Pause',exact:true}).click();
  await wait(page,proxy,'document.querySelector("video").paused');
  const paused=await read(page,proxy,'document.querySelector("video").currentTime');
  await surface.getByRole('button',{name:'Play',exact:true}).click();
  await wait(page,proxy,'document.querySelector("video").currentTime>'+JSON.stringify(paused+.2));
  return {played:true,decoded:true,seeked:true,paused:true,resumed:true};
}
