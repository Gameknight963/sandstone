import { parse } from "./javascript_parser.mjs";
const import_string=String;

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
    type: node.attributes?.find(attribute => (attribute.key.name || attribute.key.value) === "type")?.value.value || "javascript"
  }));
}

// The browser executes the graph. We provide local blobs and a complete import map
// before it resolves any dependencies, retaining native cycles and live bindings.
export class ModuleLoader {
  constructor({fetch, rewrite, createURL, register, execute}) {
    this.fetch = fetch;
    this.rewrite = rewrite;
    this.createURL = createURL;
    this.register = register;
    this.execute = execute;
    this.map = new ImportMap();
    this.records = new Map();
    this.registered = new Set();
    this.metadata = new Map();
    this.tail = Promise.resolve();
    this.inline_id = 0;
    this.module_id = 0;
    this.preamble = "";
  }

  record(key, type = "javascript", credentials = "same-origin") {
    if (!["javascript", "json"].includes(type)) throw new TypeError(`Unsupported module type: ${type}`);
    let record = this.records.get(key);
    if (record && record.type !== type) throw new TypeError(`Conflicting module types for ${key}`);
    if (!record) {
      record = {key, url: key, type, credentials, source: undefined, blob: null, nativeKey: `sandstone:module:${++this.module_id}`, dependencies: []};
      this.records.set(key, record);
    }
    return record;
  }

  serialize(action) {
    const operation = this.tail.then(action);
    this.tail = operation.catch(() => {});
    return operation;
  }

  async prepare_url(specifier, base, options = {}) {
    return this.prepare_graph(this.record(this.map.resolve(specifier, base), options.with?.type || options.assert?.type || "javascript", options.credentials || this.records.get(base)?.credentials));
  }

  prepare_inline(source, base, credentials) {
    const record = this.record(`sandstone:inline-module:${++this.inline_id}`, "javascript", credentials);
    record.url = base;
    record.source = source;
    return this.prepare_graph(record);
  }

  load_record(record){
    return record.loading??=Promise.resolve().then(async()=>{
      try{
        if (record.source === undefined) {
          const response = await this.fetch(record.key, {credentials: record.credentials});
          if (!response.ok) throw new TypeError(`Module request failed (${response.status}): ${record.key}`);
          record.url = response.url || record.key;
          record.source = await response.text();
          if (!this.records.has(record.url)) this.records.set(record.url, record);
        }
        if (record.type === "json") { JSON.parse(record.source); return; }
        record.dependencies = [];
        for (const dependency of module_dependencies(record.source)) {
          const key = this.map.resolve(dependency.specifier, record.url);
          const target = this.record(key, dependency.type, record.credentials);
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
      let source = record.type === "json" ? `export default __ctx__.__json_module__(${JSON.stringify(record.source)});` : this.rewrite(record.source, {
        module: true, url: record.url, sourceURL:record.url, stripAttributes: true, resolve: specifier => {
          const dependency = this.records.get(this.map.resolve(specifier, record.url));
          return dependency.blob || dependency.nativeKey;
        }
      });
      if (this.preamble) {
        const offset = source.startsWith("#!") ? source.indexOf("\n") + 1 || source.length : 0;
        source = source.slice(0, offset) + "\n" + this.preamble + source.slice(offset);
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
    if(Object.hasOwn(snapshot,'type')&&snapshot.type!=='json')throw new TypeError('Unsupported module import type');
    const credentials=options?.credentials;
    // Constructor-created functions use the current document/worker base,
    // after specifier conversion and option getters have finished running.
    if(typeof base==='function')base=base();
    const record = await this.prepare_url(specifier, base, {with:snapshot,credentials});
    return this.execute(record.blob);
  }

  meta(url) {
    if (!this.metadata.has(url)) this.metadata.set(url, Object.assign(Object.create(null), {
      url, resolve: specifier => this.map.resolve(specifier, url)
    }));
    return this.metadata.get(url);
  }
}
