// Playwright's waitForFunction does not re-poll a promise which resolves false.
// Await RPC/network predicates in Node before deciding whether to try again.
export async function wait_for(predicate,{timeout=30000,interval=20}={}){
  const deadline=Date.now()+timeout;
  for(;;){
    if(await predicate())return;
    if(Date.now()>=deadline)throw new Error('Asynchronous browser condition timed out');
    await new Promise(resolve=>setTimeout(resolve,interval));
  }
}
