import {CookieReplica} from '../../cookie_replica.mjs';
import * as loader from "../loader.mjs";
import * as rpc from "../../rpc.mjs";
import {storage_group} from '../storage_sync.mjs';
import {create_cookie_accessors} from '../../cookie_accessors.mjs';

const fallback=new CookieReplica();
const native_cookie=globalThis.Document&&Object.getOwnPropertyDescriptor(Document.prototype,'cookie');
const accessors=native_cookie&&create_cookie_accessors(native_cookie);
if(accessors)Object.defineProperty(Document.prototype,'cookie',accessors.descriptor);
let configured_replica,configured_context;
function replica(){
  if(configured_replica&&configured_context===loader.beacon_context)return configured_replica;
  const origin=loader.document_origin??new URL(loader.cookie_url||loader.url||'about:blank').origin;
  const group=storage_group(origin);if(!group)return fallback;
  if(!group.cookies){
    const id=loader.frame_id;
    // Same-origin document setters may target another frame's path. Sending
    // through one group port preserves their synchronous script order.
    group.cookies=new CookieReplica({submit:(text,url)=>cookie_set(id,text,url)});
  }
  return group.cookies;
}
export const cookie_snapshot=()=>replica().snapshot();
const cookie_set = rpc.create_rpc_wrapper(rpc.host, "cookie_set");
export function load_cookies(snapshot) {
  if(snapshot)replica().reset(snapshot);
}
rpc.rpc_handlers.cookies_update=(token,snapshot)=>{if(token===loader.beacon_context)load_cookies(snapshot);};
export function configure_cookies(snapshot,document_alias){
  configured_replica=undefined;configured_context=loader.beacon_context;configured_replica=replica();
  const origin=loader.document_origin??new URL(loader.cookie_url||loader.url).origin,group=storage_group(origin);
  if(accessors){
    const registry=group?(group.cookie_documents??=new WeakMap()):undefined;
    accessors.register(globalThis.document,document_alias,{get:get_cookie,set:set_cookie},registry);
  }
  load_cookies(snapshot);
  return rpc.call_procedure(rpc.host,'cookies_ready',[loader.frame_id,loader.beacon_context]).then(load_cookies);
}
export function get_cookie() {
  if(loader.document_origin==='null')throw new DOMException('Cookie origin is unavailable','SecurityError');
  try { return replica().read(loader.cookie_url||loader.url); }
  catch { return ""; }
}
export function set_cookie(value) {
  if(typeof value==='symbol')throw new TypeError('Cannot convert a Symbol to a string');
  const text=String(value);
  if(loader.document_origin==='null')throw new DOMException('Cookie origin is unavailable','SecurityError');
  try {
    replica().write(text,loader.cookie_url||loader.url,{crossSite:loader.cookie_cross_site});
  } catch {}
}
