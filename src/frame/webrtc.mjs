// Retain native descriptors before the first document hides these globals.
// A reused Window can then apply a different policy without inventing APIs
// which the browser does not provide.
const constructors=new Map(['RTCPeerConnection','webkitRTCPeerConnection'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));

export function configure_webrtc(allowed){
  for(const [name,descriptor] of constructors){
    if(allowed===true&&descriptor){Object.defineProperty(globalThis,name,descriptor);continue;}
    try{if(!Reflect.deleteProperty(globalThis,name))Object.defineProperty(globalThis,name,{value:undefined,configurable:true});}catch{}
  }
}
