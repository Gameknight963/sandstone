import * as network from "../network.mjs";
import * as loader from "../loader.mjs";
import { ctx, convert_url, intercept_property, proxy_function } from "../context.mjs";
import { modules, execute_module } from "../polyfill/module.mjs";

export const pending_scripts = [];
let script_num = 0;
const classic_types = new Set(["", "application/javascript", "text/javascript", "application/ecmascript", "text/ecmascript"]);

export function should_load(element) {
  return loader.site_settings.allow_js && (classic_types.has(element.type.trim().toLowerCase()) || element.type === "module");
}

export function rewrite_script(element) {
  const type = element.type.trim().toLowerCase();
  if (type === "importmap") {
    element.type = "application/x-sandstone-importmap";
    if (loader.site_settings.allow_js && !element.__sandstone_inert__) {
      try { modules.map.add(element.textContent, ctx.document.baseURI); }
      catch (error) { element.dispatchEvent(new Event("error")); console.error(error); }
    }
    return;
  }
  const is_module = type === "module";
  if (!classic_types.has(type) && !is_module) return;
  const enabled = loader.site_settings.allow_js && !element.__sandstone_inert__ && (is_module || !element.noModule);
  element.__sandstone_module__ = is_module;
  let script_url = element.getAttribute("src");
  const num = script_num++;
  let text = element.textContent;
  let ready = !script_url;
  let executed = false;
  let prepared;
  element.type = "application/x-sandstone-script";
  element.removeAttribute("src");

  element.__sandstone_execute__ = () => {
    if (!enabled || executed || !element.isConnected || (!script_url && !element.textContent.trim())) return;
    if (is_module) {
      executed = true;
      prepared ||= prepare_module();
      return prepared.then(async record => {
        if (!record) return;
        await execute_module(record);
        element.dispatchEvent(new Event("load"));
      }).catch(report_error);
    }
    if (!ready) return;
    executed = true;
    loader.eval_script(element, script_url ? text : element.textContent);
  };

  function report_error(error) {
    element.dispatchEvent(new Event("error"));
    console.error(error);
  }

  function prepare_module() {
    if (!enabled) return Promise.resolve(null);
    const credentials = element.crossOrigin === "use-credentials" ? "include" : "same-origin";
    return (script_url ? modules.prepare_url(convert_url(script_url, ctx.document.baseURI), ctx.document.baseURI, {credentials}) :
      modules.prepare_inline(element.textContent, ctx.document.baseURI, credentials)).catch(error => {
        report_error(error);
        return null;
      });
  }

  async function download() {
    if (!enabled || !script_url) return;
    ready = false;
    try {
      const response = await network.fetch(convert_url(script_url, ctx.document.baseURI), {
        mode:element.crossOrigin === null ? 'no-cors' : 'cors',
        credentials:element.crossOrigin === 'anonymous' ? 'same-origin' : 'include',
        referrerPolicy:element.referrerPolicy
      });
      if (!response.ok) throw new TypeError(`Script request failed: ${response.status}`);
      text = await response.text();
      element.__sandstone_url__ = response.url || convert_url(script_url, ctx.document.baseURI);
      ready = true;
      if (loader.is_loaded) element.__sandstone_execute__();
    } catch (error) {
      report_error(error);
    }
  }

  intercept_property(element, "src", {
    get: () => script_url ? convert_url(script_url, ctx.document.baseURI) : "",
    set: value => {
      script_url = String(value);
      if (is_module) {
        prepared = prepare_module();
        prepared.catch(report_error);
        if (loader.is_loaded) element.__sandstone_execute__();
      } else download();
    }
  });
  proxy_function(element, "setAttribute", (target, this_arg, args) => {
    if (String(args[0]).toLowerCase() === "src") { element.src = args[1]; return; }
    return Reflect.apply(target, this_arg, args);
  });
  if (!loader.is_loaded) pending_scripts.push([num, element]);
  if (is_module) {
    prepared = prepare_module();
    return prepared.catch(report_error);
  }
  return script_url ? download() : undefined;
}
