import { ctx, convert_url } from "../context.mjs";
import * as loader from "../loader.mjs";
import {parseDeclarativeRefresh} from '../../vendor/scramjet/refresh.mjs';

function rewrite_refresh(meta_element) {
  meta_element.setAttribute("http-equiv", "__refresh");
  const parsed = parseDeclarativeRefresh(meta_element.getAttribute("content") || '');
  if (!parsed) return;
  let url;
  try {
    // A missing target reloads the document, including its path and query.
    // An authored relative target uses the document's effective base URL.
    url = parsed.url === null ? ctx.location.href : convert_url(parsed.url, ctx.document.baseURI);
  } catch { return; }
  // Browser timers overflow after about 25 days. Split long refresh delays so
  // a large server-provided timeout cannot turn into an immediate navigation.
  let remaining = parsed.time * 1000;
  if (!Number.isFinite(remaining)) return;
  const frame = loader.frame_id;
  const wait = () => {
    const delay = Math.min(remaining, 2147483647);
    remaining -= delay;
    setTimeout(() => remaining > 0 ? wait() : loader.navigate(frame, url), delay);
  };
  wait();
}

function rewrite_csp(meta_element) {
  meta_element.setAttribute("http-equiv", "__content-security-policy");
}

export function rewrite_meta(meta_element) {
  let http_equiv = meta_element.getAttribute("http-equiv");
  if (!http_equiv) 
    return;
  http_equiv = http_equiv.trim().toLowerCase();

  if (http_equiv === "refresh")
    rewrite_refresh(meta_element);
  else if (http_equiv === "content-security-policy")
    rewrite_csp(meta_element);
}
