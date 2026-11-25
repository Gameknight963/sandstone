// Browser-side negotiation fixture. No external STUN/TURN servers or peers.
(async()=>{
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
})()
