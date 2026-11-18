import { CookieJar } from "tough-cookie";
import * as loader from "../loader.mjs";
import * as rpc from "../../rpc.mjs";
import {storage_cookie} from '../../cookie.mjs';

let cookies = new CookieJar();
const cookie_set = rpc.create_rpc_wrapper(rpc.host, "cookie_set");
export function load_cookies(snapshot) {
  if (snapshot) cookies = CookieJar.deserializeSync(snapshot);
}
export function get_cookie() {
  if(loader.document_origin==='null')throw new DOMException('Cookie origin is unavailable','SecurityError');
  try { return cookies.getCookieStringSync(loader.cookie_url||loader.url, {http: false}); }
  catch { return ""; }
}
export function set_cookie(value) {
  if(loader.document_origin==='null')throw new DOMException('Cookie origin is unavailable','SecurityError');
  try {
    const text=String(value),parsed=storage_cookie(text,{crossSite:loader.cookie_cross_site});
    if(!parsed)return;
    cookies.setCookieSync(parsed, loader.cookie_url||loader.url, {http: false, ignoreError: true});
    cookie_set(loader.frame_id, text).catch(console.error);
  } catch {}
}
