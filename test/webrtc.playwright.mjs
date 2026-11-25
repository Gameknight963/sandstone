import assert from 'node:assert/strict';

// No STUN/TURN servers or remote peers: exercise native negotiation locally.
const exchange=`(async()=>{
  const a=new RTCPeerConnection({iceServers:[]}),b=new window.RTCPeerConnection({iceServers:[]});
  let timer;
  try{
    const channel=a.createDataChannel('sandstone');
    const received=new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('Local WebRTC data channel timed out')),10000);
      b.ondatachannel=event=>{event.channel.onmessage=message=>{if(message.data==='ping')event.channel.send('pong');};};
      channel.onmessage=event=>resolve(event.data);channel.onopen=()=>channel.send('ping');
    });
    const gathered=pc=>pc.iceGatheringState==='complete'?Promise.resolve():new Promise(resolve=>pc.addEventListener('icegatheringstatechange',()=>{if(pc.iceGatheringState==='complete')resolve();}));
    await a.setLocalDescription(await a.createOffer());await gathered(a);
    await b.setRemoteDescription(a.localDescription);await b.setLocalDescription(await b.createAnswer());await gathered(b);
    await a.setRemoteDescription(b.localDescription);
    const data=await received;
    return JSON.stringify({data,typed:a instanceof RTCPeerConnection&&b instanceof RTCPeerConnection,open:channel.readyState==='open'});
  }finally{clearTimeout(timer);a.close();b.close();}
})()`;

export async function verifyWebRTC(page,{storageDenied=false}={}){
  const context=await page.context().browser().newContext();
  if(storageDenied)await context.addInitScript(()=>Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new DOMException('Storage denied','SecurityError');}}));
  const fixture=await context.newPage(),native=await context.newPage(),direct=[];
  const origin='https://webrtc-setting.test',url=origin+'/page';
  const report=id=>`parent.postMessage({rtcChild:${JSON.stringify(id)},type:typeof RTCPeerConnection},'*');`;
  const child=code=>'<!doctype html><script>'+code+'<\/script>';
  const html='<!doctype html><title>WebRTC setting</title><script>globalThis.rtcChildren={};addEventListener("message",event=>{if(event.data?.rtcChild)rtcChildren[event.data.rtcChild]=event.data.type;});<\/script>'+
    '<iframe src="/child"></iframe><iframe src="https://webrtc-child.test/child"></iframe><iframe srcdoc="'+child(report('srcdoc')).replaceAll('&','&amp;').replaceAll('"','&quot;')+'"></iframe><iframe id="blank"></iframe>';
  const install=()=>fixture.evaluate(async({url,html,same,cross})=>{
    sandstone.network.session.fetch=async input=>new Response(new URL(input).pathname==='/page'?html:new URL(input).hostname==='webrtc-setting.test'?same:cross,{headers:{'content-type':'text/html'}});
    main_frame.on_load=()=>{};await main_frame.navigate_to(url);
  },{url,html,same:child(report('same')),cross:child(report('cross'))});
  const read=source=>fixture.evaluate(source=>main_frame.eval_js(source),source);
  const inspect=async allowed=>{
    const type=allowed?'function':'undefined';
    await fixture.waitForFunction(()=>!main_frame.is_navigating);
    await fixture.waitForFunction(async()=>await main_frame.eval_js('Object.keys(globalThis.rtcChildren||{}).length===3'));
    const state=JSON.parse(await read(`JSON.stringify({type:typeof RTCPeerConnection,self:typeof self.RTCPeerConnection,window:typeof window.RTCPeerConnection,children:rtcChildren,blank:typeof document.getElementById('blank').contentWindow.RTCPeerConnection,other:typeof WebTransport})`));
    assert.deepEqual(state,{type,self:type,window:type,children:{same:type,cross:type,srcdoc:type},blank:type,other:'undefined'});
  };
  const toggle=async allowed=>{
    const previous=await fixture.evaluate(()=>main_frame.document_context);
    await fixture.locator('#allow_webrtc_input').setChecked(allowed);
    await fixture.waitForFunction(previous=>main_frame.document_context!==previous&&!main_frame.is_navigating,previous);
    await inspect(allowed);
  };
  try{
    await native.goto('about:blank');const expected=JSON.parse(await native.evaluate(source=>eval(source),exchange));assert.deepEqual(expected,{data:'pong',typed:true,open:true});
    await fixture.route(/^https?:/,route=>{direct.push(route.request().url());return route.abort();});
    await fixture.goto(page.url());await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    assert.equal(await fixture.locator('#allow_webrtc_input').isChecked(),false);
    await install();await inspect(false);
    await fixture.locator('#options_button').click();
    await toggle(true);
    assert.deepEqual(JSON.parse(await read(exchange)),expected);
    // A per-site block must override a globally enabled default in children too.
    await fixture.evaluate(async url=>{main_frame.site_settings=[{hostname:/^webrtc-setting\.test$/,allow_webrtc:false}];await main_frame.navigate_to(url);},url);await inspect(false);
    await fixture.evaluate(async url=>{main_frame.site_settings=[];await main_frame.navigate_to(url);},url);await inspect(true);
    await toggle(false);await toggle(true);
    await fixture.reload();await fixture.waitForFunction(()=>globalThis.main_frame&&sandstone.libcurl.ready&&!main_frame.is_navigating);
    assert.equal(await fixture.locator('#allow_webrtc_input').isChecked(),!storageDenied);
    await install();await inspect(!storageDenied);
    if(!storageDenied){await fixture.locator('#options_button').click();await toggle(false);}
    assert.deepEqual(direct,[]);
    return ['WebRTC is off by default; opt-in supports native local data channels and inherited iframe policy','WebRTC toggles reload the site, respect per-site blocks and persist only when browser storage is available'];
  }finally{await context.close();}
}
