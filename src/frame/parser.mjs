import { ctx_vars } from "./context.mjs";
import { rewrite_source } from "./rewrite/javascript.mjs";

export function rewrite_js(source, options={}) {
  return rewrite_source(String(source), ctx_vars, {...options,globalName:(options.contextName||'__ctx__')+'.__globals__'});
}
