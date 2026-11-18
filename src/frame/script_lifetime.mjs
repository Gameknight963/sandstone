const pending=new Set(),waiters=new Set();

export function delay_script_load(){
  const lease={};pending.add(lease);
  return ()=>{
    if(!pending.delete(lease))return;
    if(!pending.size)for(const waiter of [...waiters])waiter();
  };
}
export const pending_script_loads=()=>pending.size>0;
export async function wait_script_loads(signal){
  while(pending.size&&!signal?.aborted){
    await new Promise(resolve=>{
      const done=()=>{waiters.delete(done);signal?.removeEventListener('abort',done);resolve();};
      waiters.add(done);signal?.addEventListener('abort',done,{once:true});
      if(signal?.aborted)done();
    });
  }
}
