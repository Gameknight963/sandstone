import * as network from "../network.mjs";
import { rewrite_css } from "../css.mjs";

export function parse_css(source, base, transform, request) {
  const {importPolicy, fontFace, ...options} = request || {};
  return rewrite_css(source, base, {
    fetch: network.fetch, createURL: network.create_blob_url, request: request ? options : undefined, importPolicy, fontFace,
    // Older browsers may expose CSSImportRule.supportsText yet reject this syntax.
    supports: condition => CSS.supports(condition) || CSS.supports(`(${condition})`), transform
  }, new Set([base]));
}
