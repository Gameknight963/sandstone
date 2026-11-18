import { ModuleLoader } from "../modules.mjs";
import * as network from "../network.mjs";
import * as parser from "../parser.mjs";
import * as loader from "../loader.mjs";

// Keep native import out of webpack's chunk loader; every URL here is a prepared blob.
const native_import = Function("url", "options", "return import(url, options)");
let pending_imports = Object.create(null);

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
  fetch: (url, options) => network.fetch(url, {...options,mode:'cors'}),
  rewrite: (source, options) => parser.rewrite_js(source, options),
  createURL: (source, type, original) => network.create_blob_url(new Blob([source], {type}), original),
  register(imports) {
    Object.assign(pending_imports, imports);
    if (loader.is_loaded) flush_import_map();
  },
  execute: native_import
});

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
