import { ctx_vars } from "./context.mjs";
import { rewrite_source } from "./rewrite/javascript.mjs";
import {function_sources} from './function_sources.mjs';
import {runtime_context_name} from './runtime_context.mjs';

export function rewrite_js(source, options={}) {
  const contextName=options.contextName||runtime_context_name;
  return rewrite_source(String(source), ctx_vars, {
    functionSources:function_sources,contextName,thisName:contextName+'.__get_this__',
    withContext:'(function(){return this})()['+JSON.stringify(runtime_context_name)+']',
    ...options,globalName:contextName+'.__globals__'
  });
}
