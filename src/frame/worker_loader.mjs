import {prefetch_worker_scripts} from './worker_scripts.mjs';

export function create_worker_script_loader({cache,resolve,fetch,execute,base=()=>undefined,remember=()=>{}}){
  const pending=new Map();let tail=Promise.resolve();
  async function prepare(url){
    if(typeof cache[url]==='string')return;
    if(pending.has(url))return pending.get(url);
    const operation=tail.then(async()=>{
      if(typeof cache[url]==='string')return;
      const resource=async target=>{const response=await fetch(target);remember(target,response);return response;};
      const response=await resource(url);if(!response.ok)throw new DOMException('Worker script request failed: '+response.status,'NetworkError');
      const source=await response.text(),sources=new Map(Object.entries(cache));sources.set(url,source);
      const prepared=await prefetch_worker_scripts(source,base()||url,resource,sources,new Map(),response.url||url,{stackURL:url});
      Object.assign(cache,Object.fromEntries(prepared.cache));
    });
    pending.set(url,operation);tail=operation.catch(()=>{});
    try{await operation;}finally{pending.delete(url);}
  }
  return function load(paths,loaded,failed,runScripts=execute){
    const run=()=>{try{runScripts(...paths);loaded();}catch(error){failed(error);}};
    let urls;try{urls=paths.map(resolve);}catch{run();return;}
    if(urls.every(url=>typeof cache[url]==='string')){run();return;}
    void Promise.all(urls.map(prepare)).then(run,run);
  };
}
