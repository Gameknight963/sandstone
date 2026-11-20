import { ModuleLoader } from "../modules.mjs";
import * as network from "../network.mjs";
import * as parser from "../parser.mjs";
import * as loader from "../loader.mjs";
import {ctx} from '../context.mjs';
import {document_referrer_policy} from '../intercept/document.mjs';
import {compile_worker_cycles} from '../worker_module_compiler.mjs';
import {runtime_context_name} from '../runtime_context.mjs';
import {fetch_service_worker_script} from '../service_worker_scripts.mjs';

// Keep native import out of webpack's chunk loader; every URL here is a prepared blob.
const native_import = Function("url", "options", "return import(url, options)");
let pending_imports = Object.create(null);
let context_url;

export function flush_import_map() {
  if (!Object.keys(pending_imports).length) return;
  if (typeof document === "undefined") throw new TypeError("Cyclic module workers require a separate module resolver");
  const script = document.createElement("script");
  script.__rewritten__ = true;
  script.type = "importmap";
  script.textContent = JSON.stringify({imports: pending_imports});
  document.head.append(script);
  script.remove();
  pending_imports = Object.create(null);
}

export const modules = new ModuleLoader({
  contextModule:()=>context_url??=network.create_blob_url(new Blob(['export default '+runtime_context_name+';'],{type:'text/javascript'}),'sandstone:module-context'),
  context:()=>({referrer:ctx.location.href,referrerPolicy:document_referrer_policy(),destination:loader.worker_type==='module'?'worker':'script'}),
  types:globalThis.CSSStyleSheet?['javascript','json','css']:['javascript','json'],
  fetch: (url, options,type) => fetch_service_worker_script(url,{...options,mode:'cors',destination:type==='json'?'json':type==='css'?'style':options.destination||'script'},type,network.fetch),
  rewrite: (source, options) => parser.rewrite_js(source, options),
  createURL: (source, type, original) => network.create_blob_url(new Blob([source], {type}), original),
  register(imports) {
    Object.assign(pending_imports, imports);
    if (loader.is_loaded) flush_import_map();
  },
  execute: native_import,
  compileCycles:typeof document==='undefined'?compile_worker_cycles:undefined
});

// Worker startup evaluates an entry without Promise-assimilating an authored
// `then` export. A side-effect-only wrapper also protects acyclic entry modules.
export function evaluate_worker_module(record){
  const url=record.namespaceBlob||(record.evaluationBlob??=modules.createURL('import '+JSON.stringify(record.blob)+';','text/javascript',record.url));
  return native_import(url);
}

export function execute_module(record,{ordered=false}={}) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.__rewritten__ = true;
    script.type = "module";
    if(ordered)script.async=false;
    script.src = record.blob;
    script.onload = () => { script.remove(); resolve(); };
    script.onerror = () => { script.remove(); reject(new TypeError(`Module failed to load: ${record.url}`)); };
    document.head.append(script);
  });
}
