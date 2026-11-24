import assert from 'node:assert/strict';
import {wait_for} from './wait-for.mjs';

export async function verifyMediaSession(page){
  const fixture=await page.context().newPage(),native=await page.context().newPage();
  const origin='https://media-session.test',url=origin+'/page',html='<!doctype html><base href="/art/"><body>Media Session';
  const errors=[],direct=[];
  fixture.on('pageerror',error=>errors.push(error.message));fixture.on('request',request=>{if(/^https?:/.test(request.url()))direct.push(request.url());});
  await fixture.addInitScript(()=>{globalThis.rawArtwork=Object.getOwnPropertyDescriptor(MediaMetadata.prototype,'artwork').get;});
  const describe=()=>{
    const accesses=[],image={get sizes(){accesses.push('sizes');return '64x64';},get src(){accesses.push('src');return './cover.svg';},get type(){accesses.push('type');return 'image/svg+xml';}};
    const value=new MediaMetadata({title:'Title',artist:'Artist',album:'Album',artwork:[image]});
    const capture=operation=>{try{operation();return null;}catch(error){return error.name;}};
    return JSON.stringify({title:value.title,artist:value.artist,album:value.album,artwork:value.artwork,accesses,instance:value instanceof MediaMetadata,prototype:Object.getPrototypeOf(value)===MediaMetadata.prototype,frozen:Object.isFrozen(value.artwork),invalid:capture(()=>new MediaMetadata({artwork:[{}]})),symbol:capture(()=>new MediaMetadata({artwork:[{src:Symbol()}]})),receiver:capture(()=>Object.getOwnPropertyDescriptor(MediaMetadata.prototype,'artwork').get.call({}))});
  };
  const physical=()=>fixture.locator('iframe[frame-id]').contentFrame().locator('html').evaluate(()=>rawArtwork.call(navigator.mediaSession.metadata));
  try{
    await native.route(origin+'/**',route=>route.fulfill({contentType:'text/html',body:html}));await native.goto(url);
    const expected=JSON.parse(await native.evaluate(describe));
    await fixture.route(/^https?:/,route=>route.abort('blockedbyclient'));
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    await fixture.evaluate(async({url,html})=>{
      globalThis.artworkRequests=[];globalThis.releaseArtwork=null;
      sandstone.network.session.fetch=async(url,options)=>{
        if(!String(url).endsWith('.svg'))return new Response(null,{status:204});
        artworkRequests.push({url:String(url),cookie:new Headers(options.headers).get('cookie')});
        if(String(url).endsWith('/slow.svg'))await new Promise(resolve=>releaseArtwork=resolve);
        return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',{headers:{'content-type':'image/svg+xml'}});
      };
      main_frame.special_pages[url]=html;await main_frame.navigate_to(url);
    },{url,html});
    assert.deepEqual(JSON.parse(await fixture.evaluate(source=>main_frame.eval_js('('+source+')()'),describe.toString())),expected);
    assert.deepEqual(await fixture.evaluate(()=>artworkRequests),[],'Constructing unattached metadata must not fetch artwork');
    assert.equal(await fixture.evaluate(()=>main_frame.eval_js(`document.cookie='artwork=allowed; Path=/';globalThis.savedMetadata=new MediaMetadata({title:'First',artwork:[{src:'./cover.svg',sizes:'64x64',type:'image/svg+xml'}]});navigator.mediaSession.metadata=savedMetadata;navigator.mediaSession.setActionHandler('play',()=>{});navigator.mediaSession.metadata===savedMetadata`)),true);
    await wait_for(async()=>{const images=await physical();return images.length===1&&images[0].src.startsWith('blob:');});
    assert.equal(await fixture.evaluate(()=>main_frame.eval_js('savedMetadata.artwork[0].src')),origin+'/art/cover.svg');
    const first=(await physical())[0].src;
    await fixture.evaluate(()=>main_frame.eval_js(`savedMetadata.artwork=[{src:'./slow.svg'}];true`));
    await wait_for(()=>fixture.evaluate(()=>!!releaseArtwork));
    await fixture.evaluate(()=>main_frame.eval_js(`savedMetadata.artwork=[{src:'./new.svg'}];savedMetadata.title='Updated';true`));
    await wait_for(async()=>{const images=await physical();return images.length===1&&images[0].src.startsWith('blob:')&&images[0].src!==first;});
    const latest=(await physical())[0].src;
    await fixture.evaluate(()=>releaseArtwork());
    await fixture.evaluate(()=>main_frame.eval_js('new Promise(resolve=>setTimeout(()=>resolve(true),0))'));
    assert.equal((await physical())[0].src,latest,'An obsolete artwork response replaced newer metadata');
    assert.equal(await fixture.evaluate(()=>main_frame.eval_js('navigator.mediaSession.metadata.title')),'Updated');
    const requests=await fixture.evaluate(()=>artworkRequests);
    assert.deepEqual(requests.map(request=>request.url),['/cover.svg','/slow.svg','/new.svg'].map(path=>origin+'/art'+path));
    assert.ok(requests.every(request=>request.cookie?.includes('artwork=allowed')),'Artwork requests lost their virtual document cookies');
    assert.deepEqual(errors,[]);assert.deepEqual(direct,[]);
    return ['Media Session artwork retains native metadata identity and conversion while using relayed local images','Replacing artwork cancels stale requests without overwriting newer media controls'];
  }finally{await fixture.close();await native.close();}
}
