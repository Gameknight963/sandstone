let next=0;
const queue=[];
const callbacks=new Map();

// Preparation order is independent of download completion. Once a contiguous
// prefix is ready, native async=false scripts retain classic/module ordering,
// including modules whose evaluation is suspended by top-level await.
export function ordered_script(){
  let resolve,reject;
  const entry={ready:false,resolve:null};
  const finished=new Promise((yes,no)=>{resolve=yes;reject=no;});entry.resolve=resolve;entry.reject=reject;queue.push(entry);
  return {finished,ready(start){
    entry.ready=true;entry.start=start;
    while(queue[0]?.ready){const current=queue.shift();try{Promise.resolve(current.start()).then(current.resolve,current.reject);}catch(error){current.reject(error);}}
  }};
}

export function run(id){callbacks.get(id)?.();}
export function ordered_classic(execute){
  return new Promise((resolve,reject)=>{
    const id=++next,script=document.createElement('script');
    script.__rewritten__=true;script.async=false;
    const url=URL.createObjectURL(new Blob([`sandstone_frame.script_schedule.run(${id});`],{type:'text/javascript'}));
    const cleanup=()=>{callbacks.delete(id);script.remove();URL.revokeObjectURL(url);};
    callbacks.set(id,execute);
    script.onload=()=>{cleanup();resolve();};script.onerror=()=>{cleanup();reject(new TypeError('Ordered script runner failed'));};
    script.src=url;document.head.append(script);
  });
}
