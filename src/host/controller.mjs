import * as rpc from "../rpc.mjs";
import * as util from "../util.mjs";
import * as network from "./network.mjs";
import { site_data } from "./site_data.mjs";
import { indexed_db } from "./indexeddb.mjs";
import {crypto_service} from './crypto.mjs';
import { NavigationHistory } from "../history.mjs";
import {parse_referrer_policy,default_referrer_policy} from '../referrer.mjs';
import {is_download} from '../download.mjs';
import {frame_cross_site,worker_script_url} from './frame_context.mjs';
import './storage.mjs';
import './cookies.mjs';
import './navigation_targets.mjs';
import {navigation_sandbox} from '../navigation_policy.mjs';
import {RPCSourcePolicy} from './rpc_policy.mjs';
import {bootstrap_html,bootstrap_xml,create_bootstrap_nonce,runtime_seed} from '../bootstrap.mjs';
import {runtime_html} from '../runtime_html.mjs';
import {xml_document_type} from '../mime.mjs';
import {navigate_javascript} from './javascript_navigation.mjs';
import {decode_document_response} from '../text_encoding.mjs';
import {prepare_site_data_clear as prepare_clear} from '../site_data_clear.mjs';
import {opened_document_urls,document_request_url} from './document_url.mjs';
export { site_data } from "./site_data.mjs";
export { indexed_db } from "./indexeddb.mjs";
export {cache_storage} from './cache.mjs';
export {file_system} from './filesystem.mjs';
export function prepare_site_data_clear(hostname,selection,root){return prepare_clear(hostname,selection,root,iframes,network.beacons.contexts);}

import { version } from "./index.mjs";

import { libcurl } from "libcurl.js/bundled";

//frame_js is a string, which is imported using webpack
import frame_js from "../../dist/sandstone_frame.js";

const frame_html=runtime_html(frame_js);

export const iframes = {};
const saved_child_histories = new Map();
export const persist_storage_key = "proxy_local_storage";
export let local_storage = {};
local_storage = site_data.local;

function get_frame_bundle(nonce) {
  // A data document has its own opaque origin even with allow-same-origin.
  // Its inline descendants can inherit that identity without inheriting the
  // host's file/HTTP origin, which a blob or host-owned srcdoc would expose.
  return runtime_seed(nonce);
}

export class ProxyFrame {
  get origin() { return this.document_origin??this.url?.origin; }
  get request_url(){return this.document_origin!==undefined&&this.url?.protocol==='about:'?this.inherited_url||this.cookie_url:undefined;}
  constructor() {
    this.url = null;
    this.is_navigating = false;
    this.navigation_id = 0;
    this.session_storage = Object.create(null);
    this.history = new NavigationHistory();
    this.id = Math.random() + "";
    this.root_id = this.id;
    this.iframe = document.createElement("iframe");
    this.iframe.sandbox = "allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock";
    this.iframe.allowFullscreen = true;
    this.iframe.allow = 'focus-without-user-activation *; autoplay *; cross-origin-isolated *';
    this.iframe.setAttribute("frame-id", this.id);

    iframes[this.id] = this;
    this.rpc_target = new rpc.RPCTarget();
    this.rpc_policy=new RPCSourcePolicy({root:this.id,frames:()=>iframes,contexts:()=>network.beacons.contexts});
    this.rpc_target.authorize=(message,source)=>this.rpc_policy.authorize(message,source);
    this.rpc_target.authorize_attach=(source,port,id)=>this.rpc_policy.attach(source,port,id);
    this.rpc_target.onmessage = rpc.message_listener;
    this.send_page = (options,request={})=>rpc.call_procedure(this.rpc_target,'html',[options],request);
    this.get_favicon = rpc.create_rpc_wrapper(this.rpc_target, "favicon");
    this.eval_js = rpc.create_rpc_wrapper(this.rpc_target, "eval");

    this.on_navigate = () => {};
    this.on_load = () => {};
    this.on_url_change = () => {};

    this.special_pages = {};
    this.site_settings = [];
    this.default_settings = {
      allow_js: true
    };
  }

  async wait_for_libcurl() {
    if (libcurl.ready) return;
    await libcurl.load_wasm();
  }

  async navigate_to(url, form_data=null, navigation = {}, document_result) {
    if (!util.is_valid_url(url)) throw TypeError("Invalid URL");
    if(new URL(url).protocol==='javascript:')return navigate_javascript(this,this,url);
    const navigation_id = ++this.navigation_id;
    this.runtime_wait?.abort();
    const runtime_wait=this.runtime_wait=new AbortController();
    this.is_navigating = true;
    await this.wait_for_libcurl();
    if (navigation_id !== this.navigation_id) return;
    if (!util.is_valid_url(url)) {
      throw TypeError("Invalid URL");
    }

    console.log("navigating to", url);
    if (navigation_id !== this.navigation_id) return;
    const source_url = navigation.source_context?.url||(navigation.initiated ? this.url?.href : undefined);
    const source_policy = navigation.referrerPolicy || this.referrer_policy || default_referrer_policy;
    let html = null;
    let character_encoding = 'UTF-8';
    let content_type='text/html';
    let download_response;
    let navigation_client;
    let error = false;
    let referrer_policy = default_referrer_policy, document_referrer = '';
    let request_metadata=navigation.traversed?this.history.current?.request_metadata:undefined;

    // The fourth argument is host-only; renderer navigation RPCs never supply
    // replacement HTML or origin metadata through their navigation options.
    if(document_result){html=document_result.html;referrer_policy=document_result.referrer_policy;document_referrer=document_result.document_referrer;}
    else if (typeof this.special_pages[url] === "string") {
      html = this.special_pages[url];
    }
    else {
      try {
        let options = {signal:runtime_wait.signal};
        if (form_data) {
          console.log("placing post request:", form_data);
          options = {
            signal:runtime_wait.signal,
            method: "POST",
            headers: form_data.headers || {"Content-Type": form_data.enctype},
            body: form_data.body
          }
        }
        if (navigation.history_mode === 'reload') options.cache = 'no-cache';
        let response = await network.fetch(url, options, {url:source_url,top_url:navigation.source_context?.top_url||source_url,cross_site:navigation.source_context?.cross_site,broadcast_origin:navigation.source_context?.broadcast_origin,referrerPolicy:source_policy,navigation:true,navigation_target:this.id,navigation_owner:this.id,navigation_previous:this.document_context,request_metadata,metadata_source:navigation.history_mode==='reload'?this.url?.href:undefined,user_activation:!navigation.initiated&&!navigation.traversed||!!navigation.activation?.transient});
        navigation_client=network.navigation_client(response);
        request_metadata=response.request_metadata;
        if(navigation_id!==this.navigation_id){await response.body?.cancel();return;}
        if([204,205].includes(response.status)){await response.body?.cancel();this.is_navigating=false;return {no_navigation:true};}
        if(is_download(response.headers))download_response=response;
        else {const decoded=await decode_document_response(response);html=decoded.text;character_encoding=decoded.encoding;content_type=xml_document_type(response.headers.get('content-type'))||'text/html';}
        url = response.url;
        referrer_policy = parse_referrer_policy(response.headers.get('referrer-policy'));
        document_referrer = response.request_referrer || '';
      }
      catch (e) {
        navigation_client?.release();navigation_client=undefined;
        error = util.format_error(e);
      }  
    }
    if (navigation_id !== this.navigation_id) return;
    if(download_response){
      try{return {download:true,filename:await network.downloads.response(download_response,url),cookies:site_data.documentCookies(this.url?.href||url)};}
      finally{if(navigation_id===this.navigation_id)this.is_navigating=false;}
    }
    this.url = new URL(url);
    this.document_origin=document_result?.document_origin;this.cookie_url=document_result?.cookie_url;this.referrer_url=document_result?.referrer_url;this.inherited_url=document_result?.creator_url;
    this.broadcast_origin=document_result?.broadcast_origin||(this.url.origin==='null'?'opaque:'+this.id+':'+navigation_id:this.url.origin);
    this.iframe.style.backgroundColor = "#222222";
    this.history.save_scroll(navigation.scroll);
    this.on_navigate();
    // A fresh URL identifies the intended document and forces a real load;
    // changing only a fragment would keep the old runtime alive.
    const previous_runtime=this.runtime_url;
    const bootstrap_nonce=create_bootstrap_nonce();
    this.runtime_url=get_frame_bundle(bootstrap_nonce);
    this.iframe.src = this.runtime_url;
    if(previous_runtime)URL.revokeObjectURL(previous_runtime);
    indexed_db.disconnect(this.id);
    network.clean_ws_connections(this.id,{keep_navigation:true});
    for (const [id, frame] of Object.entries(iframes)) {
      if (frame.root_id === this.id && id !== this.id) {
        indexed_db.disconnect(id);
        network.clean_ws_connections(id);
        delete iframes[id];
      }
    }
    for (const [id, saved] of saved_child_histories) {
      if (saved.root_id === this.id) saved_child_histories.delete(id);
    }
    this.referrer_policy = referrer_policy;
    this.document_referrer = document_referrer;
    this.history.navigate(url, {mode: navigation.history_mode || "push",request_metadata,preserve_state:!!document_result});
    
    let settings = this.site_settings.find((item) => {
      return item.hostname.test(this.url.hostname);
    }) || {};
    settings = {...this.default_settings, ...settings};
    console.log("site settings:", settings);

    try{
      await rpc.wait_on_frame(this.iframe,{signal:runtime_wait.signal,nonce:bootstrap_nonce});
      const mime=error?'text/html':content_type;
      const runtime=mime==='text/html'?bootstrap_html(frame_html,bootstrap_nonce):bootstrap_xml(frame_js,mime,bootstrap_nonce);
      const runtime_url=await rpc.load_frame_runtime(this.iframe,runtime,bootstrap_nonce,{signal:runtime_wait.signal,mime});
      if(navigation_id!==this.navigation_id)return;
      this.runtime_url=runtime_url;rpc.commit_frame_runtime(this.iframe,runtime_url,bootstrap_nonce);
      await rpc.wait_on_frame(this.iframe,{signal:runtime_wait.signal,url:runtime_url,nonce:bootstrap_nonce});
    }
    catch(error){navigation_client?.release(error);if(navigation_id!==this.navigation_id)return;throw error;}
    if (navigation_id !== this.navigation_id) return;
    let msg_channel = new MessageChannel();
    this.rpc_target.set_target(msg_channel.port1);
    msg_channel.port1.start();
    try{await rpc.set_host(this.iframe, msg_channel.port2,{nonce:bootstrap_nonce});}
    catch(error){navigation_client?.release(error);if(navigation_id!==this.navigation_id)return;throw error;}
    if(navigation_id!==this.navigation_id)return;
    const beacon_context = network.beacons.register(this.id, {url: this.url.href,cookie_url:this.cookie_url,referrer_url:this.referrer_url,top_url: this.url.href,broadcast_origin:this.broadcast_origin,root_id:this.id},network.commit_navigation_client(this,navigation_client));
    this.document_context=beacon_context;
    this.rpc_policy.bind_root(msg_channel.port1,beacon_context);
    await network.bind_service_worker_client(this,runtime_wait.signal);
    if(navigation_id!==this.navigation_id)return;

    try {
      await this.send_page({
        url: this.url.href,
        html: html, character_encoding,
        inherited_base_url:document_result?.inherited_base_url,document_origin:this.document_origin,cookie_url:this.cookie_url,location_origin:document_result?.location_origin,
        frame_id: this.id,
        service_worker_host:!!this.service_worker_host,
        beacon_context,
        crypto_available: crypto_service.methods,
        referrer_policy, document_referrer,
        error: error,
        settings: settings,
        default_settings: this.default_settings,
        local_storage: local_storage[this.origin],
        session_storage: this.session_storage[this.origin],
        cookies: site_data.documentCookies(this.cookie_url||this.url.href),
        history: {...this.history.snapshot(), traversed: !!navigation.traversed, restored: navigation.history_mode === "reload"},
        version: version
      },{signal:runtime_wait.signal});
    }
    catch (e) {
      if (navigation_id !== this.navigation_id) return;
      let error_msg = util.format_error(e);
      try{await this.send_page({
        url: this.url.href,
        html: html, 
        frame_id: this.id,
        service_worker_host:!!this.service_worker_host,
        beacon_context,
        crypto_available: crypto_service.methods,
        referrer_policy, document_referrer,
        error: error_msg,
        settings: settings,
        default_settings: this.default_settings,
        local_storage: undefined,
        version: version
      },{signal:runtime_wait.signal});}
      catch(error){if(navigation_id!==this.navigation_id)return;throw error;}
    }
    if (navigation_id !== this.navigation_id) return;
    this.iframe.style.backgroundColor = "unset";
    this.is_navigating = false;
    this.on_load();
    if(navigation.result_document&&navigation_id===this.navigation_id&&this.document_context===beacon_context)return {document_context:beacon_context,failed:!!error};
  }
}

rpc.rpc_handlers["navigate"] = async (frame_id, url, reload=true, form_data=null, navigation={}) => {
  let frame = iframes[frame_id];
  if (!frame) return;
  if(new URL(url).protocol==='javascript:')return navigate_javascript(frame,frame,url);

  if (reload) {
    return await frame.navigate_to(url, form_data, {...navigation,initiated:true});
  }
  else {
    frame.url = new URL(url);
    frame.on_url_change();
  }
}

rpc.rpc_handlers["history_mutate"] = (id, kind, state, url, scroll) => {
  const frame = iframes[id];
  if (!frame?.history) throw new DOMException("Inactive history", "InvalidStateError");
  frame.history.mutate(kind, state, url, scroll,frame.broadcast_origin?.startsWith('opaque:')?'null':frame.origin||frame.url.origin);
  frame.url = new URL(url);
  frame.on_url_change();
};

rpc.rpc_handlers["history_go"] = (id, delta, scroll,activation) => {
  const frame = iframes[id];
  if (!frame?.history) return null;
  const snapshot = frame.history.go(delta, scroll);
  if (!snapshot) return null;
  if (snapshot.sameDocument) {
    frame.url = new URL(snapshot.url);
    frame.on_url_change();
    return snapshot;
  }
  frame.navigate_to(snapshot.url, null, {history_mode: "traverse", traversed: true,activation}).catch(console.error);
  return null;
};

rpc.rpc_handlers["cookie_set"] = async (frame_id, value, url, token) => {
  const context=network.beacons.contexts.get(token);
  if(!context||context.frame!==frame_id||context.cleared_storage?.cookies||context.context.broadcast_origin?.startsWith('opaque:'))return;
  const base=context.context.cookie_url||context.context.url,target=new URL(url||base);
  if(target.origin!==new URL(base).origin)throw new DOMException('Cookie origin is unavailable','SecurityError');
  site_data.setCookie(target.href,value,false,{crossSite:context.context.cross_site});
  return site_data.documentCookies(target.href,{crossSite:context.context.cross_site});
};

rpc.rpc_handlers.window_name=(id,token,value)=>{
  const frame=iframes[id],context=network.beacons.contexts.get(token);
  if(!frame?.parent_id||context?.frame!==id||context.retired||typeof value!=='string')return;
  frame.window_name=value;
  const root=iframes[frame.root_id],port=frame.parent_id===frame.root_id?root?.rpc_target.target:root?.rpc_target.extra_frame_targets.get(frame.parent_id);
  if(port)rpc.notify(port,'child_window_name',[id,value]);
};

rpc.rpc_handlers["frame_register"] = async (parent_id, child_id, url, options = {}) => {
  const parent = iframes[parent_id];
  if (!parent || iframes[child_id]) throw new TypeError("Invalid child frame");
  if(options.beacon_context!==undefined&&(typeof options.beacon_context!=='string'||!/^[a-f0-9]{32}$/.test(options.beacon_context)||network.beacons.contexts.has(options.beacon_context)))throw new TypeError('Invalid document context');
  if(options.beacon_context&&(network.reserved_navigation_client(options.beacon_context)||network.reserved_worker_client(options.beacon_context)))throw new TypeError('Reserved document context');
  const root = iframes[parent.root_id];
  const saved = saved_child_histories.get(child_id);
  saved_child_histories.delete(child_id);
  const parent_broadcast=parent.broadcast_origin||parent.origin||parent.url.origin;
  const opaque_broadcast='opaque:'+child_id+':'+Math.random();
  const srcdoc=!!options.srcdoc;
  const blank=!!options.blank,blob=!!options.blob,inherited=srcdoc||blank||blob;
  if(srcdoc&&(new URL(url).protocol!=='about:'||new URL(url).pathname!=='srcdoc'||new URL(url).search))throw new TypeError('Invalid inline frame URL');
  if(blank&&(new URL(url).protocol!=='about:'||new URL(url).pathname!=='blank'||new URL(url).search))throw new TypeError('Invalid blank frame URL');
  if(blob&&new URL(url).protocol!=='blob:')throw new TypeError('Invalid Blob frame URL');
  const inherited_origin=parent.origin||parent.url.origin;
  if(options.worker)worker_script_url(url,inherited_origin);
  const restrictions=navigation_sandbox(parent.navigation_sandbox,options.sandbox??null);
  const opaque=options.opaque||restrictions.origin||new URL(url).protocol==='data:';
  const effective_url=()=>parent.request_url||parent.url.href;
  const creator_url=blank&&options.creator_url!==undefined?new URL(options.creator_url).href:effective_url();
  if(blank&&new URL(creator_url).origin!==inherited_origin&&!(new URL(creator_url).protocol==='blob:'&&creator_url===(parent.cookie_url||parent.url.href)))throw new TypeError('Invalid blank creator URL');
  const child = {
    id: child_id, parent_id, root_id: root.id, url: new URL(url),worker:!!options.worker,
    parent_context:parent.document_context,
    navigation_sandbox:restrictions,
    window_name:saved?.window_name??options.window_name??'',
    origin: opaque?'null':inherited||options.worker?inherited_origin:new URL(url).origin,
    broadcast_origin:options.worker ? new URL(url).protocol==='data:'?opaque_broadcast:parent_broadcast : opaque?opaque_broadcast:inherited?parent_broadcast:new URL(url).origin,
    cookie_url:options.document_result&&blank?'about:blank':blob?url:inherited ? blank?creator_url:parent.cookie_url||effective_url() : undefined,
    referrer_url:blank?'about:blank':blob||options.worker&&new URL(url).protocol==='blob:'?url:undefined,
    get request_url(){
      if(!inherited||this.url.protocol!=='about:')return;
      const target=this.inherited_url||(blank?creator_url:effective_url());
      return new URL(target).protocol==='blob:'&&this.origin!=='null'?this.origin+'/':target;
    },
    session_storage: parent.session_storage,
    history: saved?.history || new NavigationHistory(),
    async navigate_to(url, form_data, navigation = {}, document_result) {
      const previous_url=child.url;
      navigation = {...navigation,source_url:navigation.source_context?.url||child.request_url||child.url.href};
      child.url = new URL(url, child.url);
      child.history.save_scroll(navigation.scroll);
      child.pending_navigation = navigation;
      const port = parent_id === root.id ? root.rpc_target.target : root.rpc_target.extra_frame_targets.get(parent_id);
      if (!port) throw new DOMException("Parent frame is disconnected", "InvalidStateError");
      const result=document_result?await rpc.call_procedure(port,'child_document_result',[child_id,child.url.href,document_result]):await rpc.call_procedure(port, "child_navigate", [child_id, child.url.href, form_data, {...navigation,from_child:true}]);
      if(result?.download||result?.no_navigation){child.url=previous_url;child.pending_navigation=null;return {...result,cookies:site_data.documentCookies(previous_url.href,{crossSite:frame_cross_site(child,iframes)})};}
      return result;
    },
    on_url_change() {
      const port=parent_id===root.id?root.rpc_target.target:root.rpc_target.extra_frame_targets.get(parent_id);
      if(port)rpc.notify(port,'child_url',[child_id,child.url.href,child.document_context]);
    }
  };
  iframes[child_id] = child;
  let worker_context;
  try{worker_context=network.commit_worker_client(child,options.worker_context);}catch(error){delete iframes[child_id];throw error;}
  const receipt=network.navigation_metadata.take(options.request_metadata_token,parent_id,child_id,url);
  if(!receipt?.attachment)network.cancel_navigation_client(child_id,parent_id,parent.document_context);
  child.history.navigate(url, {mode: options.history_mode || saved?.navigation?.history_mode || "push",request_metadata:receipt?.metadata,preserve_state:!!options.document_result});
  child.document_context=network.beacons.register(child_id, {url:document_request_url(child),cookie_url:child.cookie_url,referrer_url:child.referrer_url,top_url:root.url.href,nested:true,cross_site:frame_cross_site(child,iframes),broadcast_origin:child.broadcast_origin,root_id:root.id},worker_context||network.commit_navigation_client(child,receipt?.attachment)||options.beacon_context);
  root.rpc_policy.document(child_id,child.document_context,parent.document_context);
  await network.bind_service_worker_client(child);
  if(iframes[child_id]!==child||iframes[parent_id]!==parent||parent.document_context!==child.parent_context)throw new DOMException('Frame was superseded','AbortError');
  return {
    window_name:child.window_name,
    beacon_context: child.document_context,
    cookie_cross_site:frame_cross_site(child,iframes),
    message_origin:child.broadcast_origin.startsWith('opaque:')?'null':inherited?child.origin:undefined,
    document_origin:child.origin,
    location_origin:blob?inherited_origin:undefined,
    ...(inherited?{cookie_url:child.cookie_url}:{}),
    crypto_available: crypto_service.methods,
    local_storage: site_data.local[child.origin],
    session_storage: child.session_storage[child.origin],
    cookies: site_data.documentCookies(child.cookie_url||(child.origin === "null" ? child.url.href : child.origin + "/"),{crossSite:frame_cross_site(child,iframes)}),
    history: {...child.history.snapshot(), traversed: !!saved?.navigation?.traversed, restored: saved?.navigation?.history_mode === "reload"}
  };
};

rpc.rpc_handlers.document_open=(id,token,snapshot)=>{
  const frame=iframes[id],context=network.beacons.contexts.get(token);
  if(!frame||frame.document_context!==token||!context||context.retired)throw new DOMException('Document is unavailable','InvalidStateError');
  const urls=opened_document_urls(snapshot,frame.origin,network.beacons.contexts),{url}=urls;
  frame.document_origin=frame.origin;Object.assign(frame,urls);
  if(frame.history.current)frame.history.current.url=url.href;
  context.context.url=document_request_url(frame);context.context.cookie_url=frame.cookie_url;
  context.context.referrer_url=frame.referrer_url;
  if(context.storage)context.storage.url=url.href;
  frame.on_url_change();
};

rpc.rpc_handlers["frame_unregister"] = (child_id, options = {}) => {
  const child = iframes[child_id];
  if (!child?.parent_id) {if(options.source_frame)network.cancel_navigation_client(child_id,options.source_frame,options.source_document);return;}
  iframes[child.root_id]?.rpc_policy.forget(child_id);
  if (options.keep_history) saved_child_histories.set(child_id, {root_id: child.root_id, history: child.history, navigation: child.pending_navigation,window_name:child.window_name});
  else saved_child_histories.delete(child_id);
  for (const frame of Object.values(iframes)) {
    if (frame.parent_id === child_id) rpc.rpc_handlers["frame_unregister"](frame.id);
  }
  indexed_db.disconnect(child_id);
  network.clean_ws_connections(child_id,{keep_navigation:!!options.keep_history||!!options.keep_navigation});
  iframes[child.root_id]?.rpc_target.retire_extra_target(child_id,{
    timeout:network.beacons.grace,
    procedures:['beacon','fetch_keepalive','fetch_keepalive_read','fetch_keepalive_abort','fetch_keepalive_done','local_storage','session_storage','storage_disconnect','cookie_set']
  });
  delete iframes[child_id];
};

// Page procedures travel over the established MessagePorts, never a public window listener.
