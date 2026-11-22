import {worker_urls} from './worker_urls.mjs';
import {shared_worker_options} from '../shared_worker/options.mjs';
import {prefetch_worker_scripts} from '../frame/worker_scripts.mjs';
import {validate_module_response} from '../frame/modules.mjs';
import {parse_referrer_policy,default_referrer_policy} from '../referrer.mjs';

function abortable(operation,signal){
  if(!signal)return Promise.resolve(operation);
  const promise=Promise.resolve(operation);let abort;
  return new Promise((resolve,reject)=>{
    abort=()=>reject(signal.reason);promise.then(resolve,reject);
    if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
  }).finally(()=>signal.removeEventListener('abort',abort));
}

function cancel(response){try{response?.body?.cancel().catch(()=>{});}catch{}}
async function response_for(operation,signal){
  const promise=Promise.resolve(operation);promise.then(response=>{if(signal?.aborted)cancel(response);},()=>{});
  return abortable(promise,signal);
}
async function text(response,signal){
  if(!response.body)return '';
  const reader=response.body.getReader(),decoder=new TextDecoder();let value='';
  const abort=()=>{reader.cancel(signal.reason).catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  try{
    signal?.throwIfAborted();
    for(;;){const chunk=await abortable(reader.read(),signal);if(chunk.done)return value+decoder.decode();value+=decoder.decode(chunk.value,{stream:true});}
  }finally{signal?.removeEventListener('abort',abort);reader.releaseLock();}
}

const native_fetch=globalThis.fetch?.bind(globalThis);
function capture(value){
  if(value===undefined)return;
  const source=value.source,type=value.type;
  if(typeof source!=='string'&&!(source instanceof Blob))throw new TypeError('A captured worker source is required');
  return {source,type:String(type??(source instanceof Blob?source.type:''))};
}
function local_key(url){const value=new URL(url);value.hash='';return value.href;}

// Called only by a trusted host. Blob bodies must already be snapshotted by
// their owning renderer. Only self-contained data URLs use native fetch.
export async function prepare_worker_scripts(input,{fetch,signal,data_fetch=native_fetch}={}){
  const {script,creator}=worker_urls(input),options=shared_worker_options(input.options);
  const destination=input.destination??'sharedworker';
  if(!['worker','sharedworker'].includes(destination)||typeof fetch!=='function')throw new TypeError('A worker destination and relay fetch are required');
  const local=!['http:','https:'].includes(script.protocol),snapshot=capture(input.local_source),captured=new Map();
  if(script.protocol==='blob:'&&!snapshot||!local&&snapshot!==undefined)throw new TypeError('Only local worker URLs accept a captured source');
  for(const [url,value] of Object.entries(input.local_sources||{})){
    const target=worker_urls({url,creator_url:creator.href}).script;
    if(!['blob:','data:'].includes(target.protocol))throw new TypeError('Only local imports accept captured sources');
    captured.set(local_key(target.href),capture(value));
  }
  if(snapshot)captured.set(local_key(script.href),snapshot);
  const load_local=async url=>{
    const body=captured.get(local_key(url));
    if(body){const response=new Response(body.source,{headers:{'content-type':body.type}});Object.defineProperty(response,'url',{value:url});return response;}
    if(new URL(url).protocol==='data:'&&data_fetch)return response_for(data_fetch(url,{signal}),signal);
    throw new DOMException('Uncaptured local worker import','NetworkError');
  };
  let policy=parse_referrer_policy(input.referrer_policy);
  signal?.throwIfAborted();
  const entry=local?await load_local(script.href):await response_for(fetch(script.href,{
    method:'GET',mode:'same-origin',credentials:options.type==='classic'?'same-origin':options.credentials,destination,
    referrer:creator.href,referrerPolicy:policy,signal
  },{entry:true}),signal);
  try{
    signal?.throwIfAborted();
    if(!entry.ok)throw new TypeError('Worker request failed: '+entry.status);
    if(options.type==='module')validate_module_response(entry,'javascript',script.href);
    const finalURL=local?script.href:new URL(entry.url||script.href).href;
    if(!local&&(!/^https?:/.test(finalURL)||new URL(finalURL).origin!==creator.origin))throw new DOMException('Invalid worker response origin','SecurityError');
    policy=local?policy:parse_referrer_policy(entry.headers.get('referrer-policy'),default_referrer_policy);
    const source=await text(entry,signal);signal?.throwIfAborted();
    const sources=new Map([[finalURL,source]]),source_urls=new Map([[script.href,finalURL],[finalURL,finalURL]]),source_cross_origins=new Map([[finalURL,false]]);
    let dynamic=false;
    if(options.type==='classic'){
      const load=async url=>{
        signal?.throwIfAborted();
        const local=!/^https?:/.test(url);
        const response=local?await load_local(url):await response_for(fetch(url,{method:'GET',mode:'no-cors',credentials:'include',destination:'script',referrer:finalURL,referrerPolicy:policy,signal},{entry:false,url:finalURL}),signal);
        source_cross_origins.set(url,response.request_cross_origin??new URL(response.url||url).origin!==creator.origin);
        if(!response.ok)cancel(response);
        return {ok:response.ok,url:response.url,text:()=>text(response,signal)};
      };
      const prepared=await abortable(prefetch_worker_scripts(source,finalURL,load,sources,source_urls,finalURL,{asyncLoaders:true}),signal);dynamic=prepared.dynamic;
    }
    signal?.throwIfAborted();
    return {url:finalURL,source,sources:Object.fromEntries(sources),source_urls:Object.fromEntries(source_urls),source_cross_origins:Object.fromEntries(source_cross_origins),referrer_policy:policy,type:options.type,credentials:options.credentials,dynamic};
  }catch(error){cancel(entry);throw error;}
}
