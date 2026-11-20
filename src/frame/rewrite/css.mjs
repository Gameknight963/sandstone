import * as network from "../network.mjs";
import { rewrite_css } from "../css.mjs";
import * as loader from '../loader.mjs';

export function parse_css(source, base, transform, request, {createURL=network.create_blob_url}={}) {
  const {importPolicy, fontFace, encoding=loader.character_encoding, ...options} = request || {};
  return rewrite_css(source, base, {
    fetch: network.fetch, createURL, request: request ? options : undefined, importPolicy, fontFace,encoding,
    // Older browsers may expose CSSImportRule.supportsText yet reject this syntax.
    supports: condition => CSS.supports(condition) || CSS.supports(`(${condition})`), transform
  }, new Set([base]));
}
