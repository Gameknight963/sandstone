import { ModuleLoader } from "../modules.mjs";
import * as network from "../network.mjs";
import * as parser from "../parser.mjs";

// Keep native import out of webpack's chunk loader; every URL here is a prepared blob.
const native_import = Function("url", "options", "return import(url, options)");

export const modules = new ModuleLoader({
  fetch: (url, options) => network.fetch(url, options),
  rewrite: (source, options) => parser.rewrite_js(source, options),
  createURL: (source, type, original) => network.create_blob_url(new Blob([source], {type}), original),
  register(imports) {
    if (typeof document === "undefined") throw new TypeError("Module workers require a separate module resolver");
    const script = document.createElement("script");
    script.__rewritten__ = true;
    script.type = "importmap";
    script.textContent = JSON.stringify({imports});
    document.head.append(script);
    script.remove();
  },
  execute: native_import
});

export function execute_module(record) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.__rewritten__ = true;
    script.type = "module";
    script.src = record.blob;
    script.onload = () => { script.remove(); resolve(); };
    script.onerror = () => { script.remove(); reject(new TypeError(`Module failed to load: ${record.url}`)); };
    document.head.append(script);
  });
}
