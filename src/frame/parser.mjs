import { ctx_vars } from "./context.mjs";
import { rewrite_source } from "./rewrite/javascript.mjs";
import {function_sources} from './function_sources.mjs';

export function rewrite_js(source, options={}) {
  return rewrite_source(String(source), ctx_vars, {functionSources:function_sources,...options,globalName:(options.contextName||'__ctx__')+'.__globals__'});
}
