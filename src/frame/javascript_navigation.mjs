import * as rpc from '../rpc.mjs';
import * as loader from './loader.mjs';
import {ctx} from './context.mjs';
import {javascript_url_source} from '../javascript_url.mjs';
import {document_referrer_policy,get_current_script,set_current_script} from './intercept/document.mjs';
import {create_bootstrap_nonce} from '../bootstrap.mjs';
import {instrument_javascript_completion,create_javascript_completion} from './javascript_completion.mjs';
import {rewrite_js} from './parser.mjs';
import {create_runtime_script,append_runtime_script} from './runtime_script.mjs';
import {native_dom} from './dom_operations.mjs';

export function run_javascript_url(source){
  const key='__sandstone_completion_'+create_bootstrap_nonce(),completion=create_javascript_completion();
  const script=create_runtime_script(),previous=get_current_script();
  Object.defineProperty(globalThis,key,{value:completion,configurable:true});
  try{
    // A native classic Script retains global let/const and nonconfigurable var
    // bindings. Indirect eval gives these declarations different lifetimes.
    script.textContent=rewrite_js(instrument_javascript_completion(source,'this['+JSON.stringify(key)+']'),{
      url:ctx.document.baseURI,sourceURL:ctx.location.href,
      importReferrer:{url:ctx.location.href,credentials:'same-origin',referrerPolicy:document_referrer_policy()}
    });
    set_current_script(null);
    append_runtime_script(script,{bodyFirst:true});
    const result=completion.result();
    return result.completed?result.value:undefined;
  }finally{
    const parent=native_dom.parent.call(script);
    if(parent)native_dom.remove.call(parent,script);
    set_current_script(previous);delete globalThis[key];
  }
}

const schedule=globalThis.setTimeout.bind(globalThis),report=globalThis.reportError?.bind(globalThis);
export function evaluate_javascript_url(url,token=loader.beacon_context){
  if(!globalThis.document||token!==loader.beacon_context||!loader.is_loaded||loader.site_settings.allow_js===false)return {executed:false};
  try{
    const value=run_javascript_url(javascript_url_source(url));
    return {executed:true,...(typeof value==='string'?{html:value,document:{inherited_base_url:loader.inherited_base_url,location_origin:loader.location_origin,document_referrer:loader.document_referrer,referrer_policy:document_referrer_policy()}}:{})};
  }catch(error){if(report)report(error);else console.error(error);return {executed:true};}
}
rpc.rpc_handlers.javascript_url=(url,token)=>new Promise(resolve=>schedule(()=>resolve(evaluate_javascript_url(url,token)),0));
