import { ctx, intercept_property } from "../context.mjs";
import { parse_css } from "./css.mjs";

export function rewrite_style(element) {
  const initial = element.textContent;
  let generation = 0;
  let text;
  function update(value) {
    const current = ++generation;
    // Clear before awaiting so insertion never exposes the original remote URLs.
    text.set.call(element, "");
    const result = parse_css(value ?? "", ctx.document.baseURI);
    if (typeof result === "string") { text.set.call(element, result); return; }
    return result.then(css => {
      if (current === generation) text.set.call(element, css);
    });
  }
  text = intercept_property(element, "textContent", {
    get: () => text.get.call(element),
    set: value => { update(value); }
  });
  let html = intercept_property(element, "innerHTML", {
    get: () => html.get.call(element),
    set: value => { update(value); }
  });
  return update(initial);
}
