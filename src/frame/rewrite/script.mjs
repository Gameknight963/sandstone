import * as network from "../network.mjs";
import * as loader from "../loader.mjs";
import { ctx, convert_url, intercept_property, proxy_function } from "../context.mjs";

export const pending_scripts = [];
let script_num = 0;
const classic_types = new Set(["", "application/javascript", "text/javascript", "application/ecmascript", "text/ecmascript"]);

export function should_load(element) {
  return loader.site_settings.allow_js && classic_types.has(element.type.trim().toLowerCase());
}

export function rewrite_script(element) {
  const type = element.type.trim().toLowerCase();
  if (!classic_types.has(type)) return;
  const enabled = loader.site_settings.allow_js && !element.__sandstone_inert__;
  let script_url = element.getAttribute("src");
  const num = script_num++;
  let text = element.textContent;
  let ready = !script_url;
  let executed = false;
  element.type = "application/x-sandstone-script";
  element.removeAttribute("src");

  element.__sandstone_execute__ = () => {
    if (!enabled || !ready || executed || !element.isConnected) return;
    executed = true;
    loader.eval_script(element, script_url ? text : element.textContent);
  };

  async function download() {
    if (!enabled || !script_url) return;
    ready = false;
    try {
      const response = await network.fetch(convert_url(script_url, ctx.document.baseURI));
      if (!response.ok) throw new TypeError(`Script request failed: ${response.status}`);
      text = await response.text();
      ready = true;
      if (loader.is_loaded) element.__sandstone_execute__();
    } catch (error) {
      element.dispatchEvent(new Event("error"));
      console.error(error);
    }
  }

  intercept_property(element, "src", {
    get: () => script_url ? convert_url(script_url, ctx.document.baseURI) : "",
    set: value => { script_url = String(value); download(); }
  });
  proxy_function(element, "setAttribute", (target, this_arg, args) => {
    if (String(args[0]).toLowerCase() === "src") { element.src = args[1]; return; }
    return Reflect.apply(target, this_arg, args);
  });
  if (!loader.is_loaded) pending_scripts.push([num, element]);
  return script_url ? download() : undefined;
}
