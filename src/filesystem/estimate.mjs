const encoder=new TextEncoder();
const catalogBytes=(entries,origin)=>{
  const owned=(entries||[]).filter(entry=>entry.origin===origin);
  return owned.length?encoder.encode(JSON.stringify(owned)).length:0;
};
export function estimate_storage(origin,state,fileBytes,quota){
  // The brokers without byte accounting contribute their known catalog data.
  // These are lower-bound estimates, not host-global usage: another virtual
  // site's data must never change the usage exposed to this origin.
  const local=(state.local?.[origin]||[]).reduce((sum,[key,value])=>sum+2*(String(key).length+String(value).length),0);
  const usageDetails={fileSystem:fileBytes,localStorage:local,indexedDB:catalogBytes(state.indexed,origin),caches:catalogBytes(state.cacheStorage,origin),serviceWorkerRegistrations:catalogBytes(state.serviceWorkers,origin)};
  const usage=Object.values(usageDetails).reduce((sum,value)=>sum+value,0);
  return {usage,quota:Math.max(quota,usage),usageDetails};
}
