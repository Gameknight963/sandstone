import { parse } from "./javascript_parser.mjs";
import {parse_referrer_policy} from '../referrer.mjs';
import {module_context_name} from './rewrite/module_context.mjs';
import {mime_essence} from '../mime.mjs';
import {javascript_mime_essence} from './script_types.mjs';
import {static_module_type} from './module_attributes.mjs';
const import_string=String;

export function validate_module_response(response,type,url){
  const mime=mime_essence(response.headers.get('content-type'));
  const valid=type==='javascript'?javascript_mime_essence(mime):type==='json'?mime==='application/json'||mime==='text/json'||!!mime?.endsWith('+json'):mime==='text/css';
  if(!valid){
    response.body?.cancel().catch(()=>{});
    throw new TypeError(`Invalid ${type} module MIME type: ${url}`);
  }
}

function url_like(value, base) {
  try {
    return /^(\/|\.\/|\.\.\/)/.test(value) ? new URL(value, base).href : new URL(value).href;
  } catch { return null; }
}

export class ImportMap {
  constructor() { this.imports = new Map(); this.scopes = new Map(); this.resolved = new Map(); }

  add(input, base) {
    const data = typeof input === "string" ? JSON.parse(input) : input;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new TypeError("Invalid import map");
    const merge = (target, entries) => {
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) return;
      for (const [key, value] of Object.entries(entries)) {
        if (!key) continue;
        const normalized = url_like(key, base) || key;
        if (target.has(normalized)) continue;
        let address = null;
        try { if (typeof value === "string") address = new URL(value, base).href; } catch {}
        target.set(normalized, normalized.endsWith("/") && !address?.endsWith("/") ? null : address);
      }
    };
    merge(this.imports, data.imports);
    for (const [scope, entries] of Object.entries(data.scopes || {})) {
      const prefix = new URL(scope, base).href;
      if (!this.scopes.has(prefix)) this.scopes.set(prefix, new Map());
      merge(this.scopes.get(prefix), entries);
    }
  }

  resolve(specifier, base) {
    specifier = String(specifier);
    const cache_key = JSON.stringify([specifier, base]);
    if (this.resolved.has(cache_key)) return this.resolved.get(cache_key);
    const absolute = url_like(specifier, base);
    const normalized = absolute || specifier;
    const lookup = entries => {
      const matches = [...entries.keys()].filter(key => key === normalized || (key.endsWith("/") && normalized.startsWith(key))).sort((a, b) => b.length - a.length);
      if (!matches.length) return undefined;
      const key = matches[0];
      const value = entries.get(key);
      if (value === null) throw new TypeError(`Import blocked by import map: ${specifier}`);
      if (key === normalized) return value;
      const result = new URL(normalized.slice(key.length), value).href;
      if (!result.startsWith(value)) throw new TypeError(`Import escapes its mapped prefix: ${specifier}`);
      return result;
    };
    const scopes = [...this.scopes.keys()].filter(prefix => base === prefix || (prefix.endsWith("/") && base.startsWith(prefix))).sort((a, b) => b.length - a.length);
    let result;
    for (const scope of scopes) { result = lookup(this.scopes.get(scope)); if (result !== undefined) break; }
    if (result === undefined) result = lookup(this.imports);
    result ??= absolute;
    if (!result) throw new TypeError(`Unmapped module specifier: ${specifier}`);
    this.resolved.set(cache_key, result);
    return result;
  }
}

export function module_dependencies(source) {
  const ast = parse(source, {module: true, next: true});
  return ast.body.filter(node => ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source).map(node => ({
    specifier: node.source.value,
    type: static_module_type(node)
  }));
}

// The browser executes the graph. We provide local blobs and a complete import map
// before it resolves any dependencies, retaining native cycles and live bindings.
export class ModuleLoader {
  constructor({fetch, rewrite, createURL, register, execute, compileCycles,contextModule,types=['javascript','json','css'],context=()=>({})}) {
    this.fetch = fetch;
    this.rewrite = rewrite;
    this.createURL = createURL;
    this.register = register;
    this.execute = execute;
    this.compileCycles=compileCycles;
    this.contextModule=contextModule;
    this.types=new Set(types);
    this.context=context;
    this.map = new ImportMap();
    this.records = new Map();
    this.registered = new Set();
    this.metadata = new Map();
    this.tail = Promise.resolve();
    this.inline_id = 0;
    this.module_id = 0;
    this.preamble = "";
  }

  context_url(){
    return this.contextModule?(this.contextModuleURL??=this.contextModule()):undefined;
  }

  get_record(url,type='javascript'){
    return this.records.get(JSON.stringify([url,type]));
  }

  record(key, type = "javascript", credentials = "same-origin",context) {
    if (!this.types.has(type)) throw new TypeError(`Unsupported module type: ${type}`);
    let record = this.get_record(key,type);
    if (!record) {
      const request={...(typeof context==='function'?context():context||this.context())};
      record = {key, url: key, type, credentials,request,policy:parse_referrer_policy(request.referrerPolicy), source: undefined, blob: null, nativeKey: `sandstone:module:${++this.module_id}`, dependencies: []};
      this.records.set(JSON.stringify([key,type]), record);
    }
    return record;
  }

  serialize(action) {
    const operation = this.tail.then(action);
    this.tail = operation.catch(() => {});
    return operation;
  }

  async prepare_url(specifier, base, options = {}) {
    const context=()=>({
      ...(options.context||this.context()),
      ...(options.destination!==undefined?{destination:options.destination}:{}),
      ...(options.referrer!==undefined?{referrer:options.referrer}:{}),
      ...(options.referrerPolicy!==undefined?{referrerPolicy:options.referrerPolicy}:{})
    });
    return this.prepare_graph(this.record(this.map.resolve(specifier, base), options.with?.type || options.assert?.type || "javascript", options.credentials || this.get_record(base)?.credentials,context));
  }

  prepare_inline(source, base, credentials,context) {
    const record = this.record(`sandstone:inline-module:${++this.inline_id}`, "javascript", credentials,context);
    record.url = base;
    record.source = source;
    return this.prepare_graph(record);
  }

  load_record(record){
    return record.loading??=Promise.resolve().then(async()=>{
      try{
        if (record.source === undefined) {
          const response = await this.fetch(record.key, {credentials: record.credentials,...record.request},record.type);
          if (!response.ok) throw new TypeError(`Module request failed (${response.status}): ${record.key}`);
          record.url = response.url || record.key;
          record.policy=parse_referrer_policy(response.headers.get('referrer-policy'),record.policy);
          validate_module_response(response,record.type,record.key);
          record.source = await response.text();
          if (!this.get_record(record.url,record.type)) this.records.set(JSON.stringify([record.url,record.type]), record);
        }
        if (record.type === "json") { JSON.parse(record.source); return; }
        if(record.type==='css')return;
        record.dependencies = [];
        for (const dependency of module_dependencies(record.source)) {
          const key = this.map.resolve(dependency.specifier, record.url);
          const target = this.record(key, dependency.type, record.credentials,{referrer:record.url,referrerPolicy:record.policy,...(record.request.destination!==undefined?{destination:record.request.destination}:{})});
          record.dependencies.push(target);
        }
      } catch (error) { record.error = error; throw error; }
    });
  }

  async prepare_graph(entry) {
    let queue = [entry];
    const graph = new Set();
    while(queue.length){
      const next=[];
      await Promise.all(queue.map(async record=>{
        if(graph.has(record)||record.blob)return;
        graph.add(record);await this.load_record(record);
        next.push(...record.dependencies);
      }));
      queue=next;
    }
    return this.serialize(()=>this.compile_graph(entry,graph));
  }

  compile_graph(entry,graph){
    const compile = record => {
      const contextURL=this.context_url();
      const contextName=contextURL?(record.type==='javascript'?module_context_name(record.source):'__sandstone_module_context__'):'__ctx__';
      let source = record.type === "json" ? `export default ${contextName}.__json_module__(${JSON.stringify(record.source)});` : record.type==='css'?`export default ${contextName}.__css_module__(${JSON.stringify(record.source)},${JSON.stringify(record.url)});`:this.rewrite(record.source, {
        module: true, url: record.url, sourceURL:record.url,importReferrer:{key:record.key}, stripAttributes: true,
        ...(contextURL?{contextName,thisName:contextName+'.__get_this__'}:{}),
        resolveNamespace:(specifier,type)=>this.get_record(this.map.resolve(specifier,record.url),type)?.namespaceBlob,
        resolve: (specifier,type) => {
          const dependency = this.get_record(this.map.resolve(specifier, record.url),type);
          return dependency.blob || dependency.nativeKey;
        }
      });
      const prefix=(contextURL?'import '+contextName+' from '+JSON.stringify(contextURL)+';\n':'')+this.preamble.replaceAll('__ctx__',contextName);
      if (prefix) {
        const offset = source.startsWith("#!") ? source.indexOf("\n") + 1 || source.length : 0;
        source = source.slice(0, offset) + "\n" + prefix + source.slice(offset);
      }
      record.blob = this.createURL(source, "text/javascript", record.url);
    };
    // DAGs need no import map at all. This also supports dynamic chunk loading in
    // browsers that only accept one import map per document.
    const remaining = new Set([...graph].filter(record=>!record.blob));
    let progress = true;
    while (remaining.size && progress) {
      progress = false;
      for (const record of remaining) {
        if (record.dependencies.some(dependency => !dependency.blob)) continue;
        compile(record);
        remaining.delete(record);
        progress = true;
      }
    }
    if(remaining.size&&this.compileCycles)return this.compileCycles(entry,remaining,this);
    for (const record of remaining) compile(record);
    const imports = Object.create(null);
    for (const record of remaining) {
      if (!this.registered.has(record.nativeKey)) imports[record.nativeKey] = record.blob;
    }
    if (Object.keys(imports).length) {
      this.register(imports);
      Object.keys(imports).forEach(key => this.registered.add(key));
    }
    return entry;
  }

  async import(specifier, base, options) {
    if(typeof specifier==='symbol')throw new TypeError('Cannot convert a Symbol to a string');
    specifier=import_string(specifier);
    const object=value=>value!==null&&(typeof value==='object'||typeof value==='function');
    if(options!==undefined&&!object(options))throw new TypeError('Invalid module import options');
    const provided=options?.with,attributes=provided===undefined?(options?.assert??{}):provided,snapshot=Object.create(null);
    if(!object(attributes))throw new TypeError('Invalid module import attributes');
    for(const [key,value] of Object.entries(attributes)){
      if(typeof value!=='string')throw new TypeError('Module import attributes must be strings');
      Object.defineProperty(snapshot,key,{value,enumerable:true});
    }
    if(Object.keys(snapshot).some(key=>key!=='type'))throw new TypeError('Unsupported module import attribute');
    if(Object.hasOwn(snapshot,'type')&&!['json','css'].includes(snapshot.type))throw new TypeError('Unsupported module import type');
    const credentials=options?.credentials;
    // Constructor-created functions use the current document/worker base,
    // after specifier conversion and option getters have finished running.
    // Inline modules can share a URL while retaining different fetch options.
    // Rewritten imports carry their record identity, separately from URL labels.
    const reference=base&&typeof base==='object';
    const parent=reference&&Object.hasOwn(base,'key')?this.get_record(base.key):undefined;
    const script=!parent&&reference&&Object.hasOwn(base,'url')&&typeof base.url==='string'?base:undefined;
    if(parent)base=parent.url;
    else if(script)base=script.url;
    else if(typeof base==='function')base=base();
    const context=parent?{referrer:parent.url,referrerPolicy:parent.policy}:script?{referrer:script.url,referrerPolicy:script.referrerPolicy}:undefined;
    const record = await this.prepare_url(specifier, base, {with:snapshot,credentials:credentials??parent?.credentials??script?.credentials,context,destination:'script'});
    return record.namespaceBlob?(await this.execute(record.namespaceBlob)).namespace:this.execute(record.blob);
  }

  meta(url) {
    if (!this.metadata.has(url)) this.metadata.set(url, Object.assign(Object.create(null), {
      url, resolve: specifier => this.map.resolve(specifier, url)
    }));
    return this.metadata.get(url);
  }
}
