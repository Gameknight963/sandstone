let report,sequence=0;

export function configure_worker_tasks(send){report=send;}

// Native worker messages and host RPC use different ports. Announce pending
// registrations on the worker's outgoing port so its owner cannot observe a
// readiness message before the corresponding host resource exists.
export function worker_task(promise){
  if(!report)return promise;
  const id=++sequence,send=report;send({type:'task-pending',id});
  const settled=()=>send({type:'task-settled',id});
  Promise.resolve(promise).then(settled,settled);
  return promise;
}
