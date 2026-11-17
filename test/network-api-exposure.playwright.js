async page=>{
  const disabled=['navigation','NavigationPrecommitController','RTCPeerConnection','webkitRTCPeerConnection','WebSocketStream','WebTransport','SharedWorker'];
  const inspect=`(()=>{const keys=${JSON.stringify(disabled)},surfaces=[globalThis,self,typeof window==='undefined'?null:window].filter(Boolean);return {blocked:surfaces.map(surface=>Object.fromEntries(keys.map(key=>[key,{present:key in surface,type:typeof surface[key],descriptor:!!Object.getOwnPropertyDescriptor(surface,key)}]))),websocket:typeof WebSocket,worker:typeof Worker};})()`;
  const verify=(result,label)=>{
    for(const surface of result.blocked)for(const [name,entry] of Object.entries(surface))if(entry.present||entry.type!=='undefined'||entry.descriptor)throw new Error(label+' exposes unsupported native '+name+': '+JSON.stringify(entry));
    if(result.websocket!=='function'||result.worker!=='function')throw new Error(label+' lost a supported relay API');
  };
  verify(JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),'JSON.stringify('+inspect+')')),'Document');
  const source=`(async()=>{const url=URL.createObjectURL(new Blob([${JSON.stringify('postMessage(JSON.stringify('+inspect+'));')}],{type:'text/javascript'})),worker=new Worker(url);try{return await new Promise((resolve,reject)=>{worker.onmessage=event=>resolve(event.data);worker.onerror=()=>reject(new Error('Network API worker failed'));setTimeout(()=>reject(new Error('Network API worker timed out')),3000);});}finally{worker.terminate();URL.revokeObjectURL(url);}})()`;
  verify(JSON.parse(await page.evaluate(source=>main_frame.eval_js(source),source)),'Worker');
  return ['Unsupported native network APIs are absent from document/worker feature detection while relayed WebSocket and Worker remain available'];
}
