import { parse } from "meriyah";

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
  }

  record(key, type = "javascript", credentials = "same-origin") {
    if (!["javascript", "json"].includes(type)) throw new TypeError(`Unsupported module type: ${type}`);
    let record = this.records.get(key);
    if (record && record.type !== type) throw new TypeError(`Conflicting module types for ${key}`);
    if (!record) {
      record = {key, url: key, type, credentials, source: undefined, blob: null};
      this.records.set(key, record);
    }
    return record;
  }

  serialize(action) {
    const operation = this.tail.then(action);
    this.tail = operation.catch(() => {});
    return operation;
  }

  prepare_url(specifier, base, options = {}) {
    return this.serialize(() => this.prepare_graph(this.record(this.map.resolve(specifier, base), options.with?.type || "javascript", options.credentials || this.records.get(base)?.credentials)));
  }

  prepare_inline(source, base, credentials) {
    const record = this.record(`sandstone:inline-module:${++this.inline_id}`, "javascript", credentials);
    record.url = base;
    record.source = source;
    return this.serialize(() => this.prepare_graph(record));
  }

  async prepare_graph(entry) {
    const queue = [entry];
    const graph = new Set();
    while (queue.length) {
      const record = queue.shift();
      if (graph.has(record) || record.blob) continue;
      graph.add(record);
      if (record.error) throw record.error;
      try {
        if (record.source === undefined) {
          const response = await this.fetch(record.key, {credentials: record.credentials});
          if (!response.ok) throw new TypeError(`Module request failed (${response.status}): ${record.key}`);
          record.url = response.url || record.key;
          record.source = await response.text();
          if (!this.records.has(record.url)) this.records.set(record.url, record);
        }
        if (record.type === "json") { JSON.parse(record.source); continue; }
        for (const dependency of module_dependencies(record.source)) {
          const key = this.map.resolve(dependency.specifier, record.url);
          queue.push(this.record(key, dependency.type, record.credentials));
        }
      } catch (error) { record.error = error; throw error; }
    }
    const compiled = [...graph].map(record => [record, record.type === "json" ? record.source : this.rewrite(record.source, {
      module: true, url: record.url, resolve: specifier => this.map.resolve(specifier, record.url)
    })]);
    for (const [record, source] of compiled) record.blob = this.createURL(source, record.type === "json" ? "application/json" : "text/javascript", record.url);
    const imports = Object.create(null);
    for (const [key, record] of this.records) {
      if (record.blob && !this.registered.has(key)) imports[key] = record.blob;
    }
    if (Object.keys(imports).length) {
      this.register(imports);
      Object.keys(imports).forEach(key => this.registered.add(key));
    }
    return entry;
  }

  async import(specifier, base, options) {
    const record = await this.prepare_url(specifier, base, options);
    return this.execute(record.blob, options);
  }

  meta(url) {
    if (!this.metadata.has(url)) this.metadata.set(url, Object.assign(Object.create(null), {
      url, resolve: specifier => this.map.resolve(specifier, url)
    }));
    return this.metadata.get(url);
  }
}
