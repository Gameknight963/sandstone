import { ctx, convert_url, intercept_property } from "../context.mjs";
import * as network from "../network.mjs";
import * as loader from "../loader.mjs";
import * as util from "../../util.mjs";
import * as rpc from "../../rpc.mjs";
import {parse_referrer_policy} from '../../referrer.mjs';
import {document_referrer_policy} from '../intercept/document.mjs';
import {is_download} from '../../download.mjs';
import {save_response} from '../downloads.mjs';
import {intercept_iframe_window,native_frame_window} from '../iframe_window.mjs';
import {child_message_parent} from '../window_messages.mjs';
import {track_iframe} from '../iframe_lifecycle.mjs';
import {sandbox_tokens} from '../../navigation_policy.mjs';
import {resource_attribute} from '../resource_attributes.mjs';
import {register_media_attributes,render_media_attribute,media_attribute_mirror} from '../media_attributes.mjs';
import {delay_script_load} from '../script_lifetime.mjs';

const inline_frames=new WeakMap(),sandbox_lists=new WeakMap();
const inline_descriptor=globalThis.HTMLIFrameElement&&Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'srcdoc');
const source_descriptor=globalThis.HTMLIFrameElement&&Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'src');
const sandbox_descriptor=globalThis.HTMLIFrameElement&&Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'sandbox');
if(inline_descriptor)Object.defineProperty(HTMLIFrameElement.prototype,'srcdoc',{...inline_descriptor,
  get(){return inline_frames.get(this)?.source()??inline_descriptor.get.call(this);},
  set(value){const state=inline_frames.get(this);return state?state.set(`${value}`):inline_descriptor.set.call(this,value);}
});
if(source_descriptor)Object.defineProperty(HTMLIFrameElement.prototype,'src',{...source_descriptor,
  get(){const state=inline_frames.get(this);return state?state.url():source_descriptor.get.call(this);},
  set(value){const state=inline_frames.get(this);return state?state.set_src(`${value}`):source_descriptor.set.call(this,value);}
});
if(sandbox_descriptor)Object.defineProperty(HTMLIFrameElement.prototype,'sandbox',{...sandbox_descriptor,
  get(){return inline_frames.get(this)?.sandbox||sandbox_descriptor.get.call(this);},
  set(value){const state=inline_frames.get(this);return state?state.set_sandbox(`${value}`):sandbox_descriptor.set.call(this,value);}
});
if(globalThis.DOMTokenList){
  for(const key of ['add','remove','toggle','replace']){
    const native=DOMTokenList.prototype[key];
    DOMTokenList.prototype[key]=new Proxy(native,{apply(target,receiver,args){
      const result=Reflect.apply(target,receiver,args);sandbox_lists.get(receiver)?.();return result;
    }});
  }
  const value=Object.getOwnPropertyDescriptor(DOMTokenList.prototype,'value');
  Object.defineProperty(DOMTokenList.prototype,'value',{...value,set(input){value.set.call(this,input);sandbox_lists.get(this)?.();}});
}

export function rewrite_iframe(iframe_element) {
  const frame_id = Math.random() + "";
  const message_token=crypto.randomUUID();
  const register = rpc.create_rpc_wrapper(rpc.host, "frame_register");
  const unregister = rpc.create_rpc_wrapper(rpc.host, "frame_unregister");
  let registered = false;
  let iframe_src = iframe_element.src;
  let authored_src = iframe_element.getAttribute('src');
  const authored=new Map(['src','srcdoc','sandbox'].map(key=>[key,iframe_element.getAttribute(key)]));
  let physical_inline='',finish_load,active_target,native_runtime_load,set_src;
  let runtime_sandbox=authored.get('srcdoc')!==null;
  listen_runtime(iframe_element,'load',event=>{
    if(event.isTrusted&&(runtime_sandbox||iframe_url||native_runtime_load)){event.stopImmediatePropagation();native_runtime_load?.(event);}
  },true);
  const release_load=()=>{finish_load?.();finish_load=undefined;};
  const render_sandbox=()=>{
    const value=authored.get('sandbox');
    render_media_attribute(iframe_element,'sandbox',value===null?'':runtime_sandbox?value+' allow-scripts':value);
  };
  const update_inline=(key,value)=>{
    if(key==='src')return set_src(value);
    authored.set(key,value);
    if(key==='sandbox'){render_sandbox();return;}
    // Never install authored markup in the physical document.
    render_media_attribute(iframe_element,'srcdoc',value===null?'':physical_inline);
    if(value!==null){runtime_sandbox=true;render_sandbox();fetch_src('about:srcdoc',null,{srcdoc:true}).catch(console.error);}
    else {physical_inline='';set_src(authored_src);}
  };
  register_media_attributes(iframe_element,authored,update_inline,key=>update_inline(key,null));
  const mirror=media_attribute_mirror(iframe_element),sandbox=sandbox_descriptor.get.call(mirror);
  const source_url=()=>{if(authored_src===null)return '';try{return convert_url(authored_src,ctx.document.baseURI);}catch{return authored_src;}};
  inline_frames.set(iframe_element,{source:()=>authored.get('srcdoc')??'',set:value=>update_inline('srcdoc',value),url:source_url,set_src:value=>set_src(value),sandbox,set_sandbox:value=>update_inline('sandbox',value)});
  sandbox_lists.set(sandbox,()=>update_inline('sandbox',mirror.getAttribute('sandbox')));
  for(const key of authored.keys())resource_attribute(iframe_element,key,()=>authored.get(key));
  render_sandbox();
  if(authored.get('srcdoc')!==null){render_media_attribute(iframe_element,'src','');render_media_attribute(iframe_element,'srcdoc','');}
  const authored_internal=iframe_element.getAttribute('__src');
  resource_attribute(iframe_element,'src',()=>authored_src);
  resource_attribute(iframe_element,'__src',()=>authored_internal);
  let initial_name=iframe_element.name;
  let window_name=initial_name,opaque_origin=false;
  let iframe_url = "";
  let generation=0,active_request,commit=Promise.resolve();
  const retire=()=>{
    generation++;active_request?.abort();iframe_url='';active_target=undefined;release_load();
    const release=commit.then(async()=>{
      if(registered){await unregister(frame_id);registered=false;}
      loader.child_navigators.delete(frame_id);
      loader.child_names.delete(frame_id);
      loader.child_urls.delete(frame_id);
    });
    commit=release.catch(console.error);
  };

  let fetch_src = async (value, form_data = null, navigation = {}) => {
    if(!iframe_element.isConnected||iframe_element.ownerDocument!==document)return;
    const inline=navigation.srcdoc||new URL(value,ctx.document.baseURI).href.split('#')[0]==='about:srcdoc';
    if(inline&&authored.get('srcdoc')===null)return;
    if(!navigation.srcdoc&&active_target&&inline&&iframe_url.split('#')[0]==='about:srcdoc'&&String(value).includes('#')&&navigation.history_mode!=='reload'){
      return rpc.call_procedure(active_target,'navigate_fragment',[value]);
    }
    const target_url=convert_url(value,ctx.document.baseURI);
    runtime_sandbox=true;render_sandbox();
    const inherited_base_url=inline?ctx.document.baseURI:undefined;
    if(inline&&!finish_load)finish_load=delay_script_load();
    const revision=++generation;
    active_request?.abort();
    const controller=active_request=new AbortController();
    const current=()=>revision===generation&&iframe_element.isConnected&&iframe_element.ownerDocument===document;
    const previous_url=iframe_url;
    //download the proxied html
    iframe_element.setAttribute("__src", value);
    console.log("navigating iframe to", target_url);
    let final_url = target_url;
    let error; //possible network error
    let html;
    let referrer_policy, document_referrer;
    if(inline){html=authored.get('srcdoc');referrer_policy=document_referrer_policy();document_referrer=loader.document_referrer;}
    else try {
      let response = await network.fetch(target_url, {
        signal:controller.signal,
        mode:'navigate',sandstone_frame_id:navigation.from_child ? frame_id : loader.frame_id,
        sandstone_navigation_source:navigation.source_context,
        cache:navigation.history_mode === 'reload' ? 'no-cache' : 'default',
        referrerPolicy:navigation.referrerPolicy || iframe_element.referrerPolicy || document_referrer_policy(),
        ...(form_data ? {
        method: "POST", headers: form_data.headers || {"Content-Type": form_data.enctype}, body: form_data.body
      } : {})});
      if(!current())return;
      if(is_download(response.headers)){
        try{const filename=await save_response(response);return current()?{download:true,filename}:undefined;}
        catch(error){if(!current())return;console.error(error);return {download:true};}
        finally{if(current()){iframe_element.setAttribute('__src',previous_url);release_load();}}
      }
      html = await response.text();
      final_url = response.url;
      referrer_policy = parse_referrer_policy(response.headers.get('referrer-policy'));
      document_referrer = response.request_referrer || '';
    }
    catch (e) {
      if(!current())return;
      error = util.format_error(e);
    }
    if(!current())return;
    // Fetches may overlap, but installation and host registration must finish
    // in order. Even a superseded installation records its registration reply
    // so the next one can unregister it before claiming the same frame ID.
    const installation=commit.then(async()=>{
      if(!current())return;
      if (registered) {await unregister(frame_id, {keep_history: true});registered=false;}
      if(!current())return;

      //load the frame runtime
      const use_inline=authored.get('srcdoc')!==null;
      const runtime_url=use_inline?'about:srcdoc#'+crypto.randomUUID():network.create_blob_url(new Blob([loader.frame_html], {type: "text/html"}));
      const runtime_html=use_inline?loader.frame_html.replace(/(<head[^>]*>)/i,'$1<script>history.replaceState(null,"",'+JSON.stringify(runtime_url)+');document.currentScript.remove();<\/script>'):undefined;
      await new Promise((resolve) => {
        const cleanup=()=>{if(native_runtime_load===loaded)native_runtime_load=undefined;controller.signal.removeEventListener('abort',aborted);};
        const aborted=()=>{cleanup();resolve();};
        const loaded=event=>{
          event.stopImmediatePropagation();
          cleanup();resolve();
        };
        native_runtime_load=loaded;
        controller.signal.addEventListener('abort',aborted,{once:true});
        if(use_inline){physical_inline=runtime_html;render_media_attribute(iframe_element,'srcdoc',runtime_html);}
        else if(authored_src!==null)render_media_attribute(iframe_element,'src',runtime_url);
        else native_frame_window(iframe_element).location.href=runtime_url;
      });
      if(!current())return;
      // A load event may belong to the previous document or the blank reset.
      // The reflected src is virtual, so identify the physical runtime explicitly.
      try{await rpc.wait_on_frame(iframe_element,{signal:controller.signal,url:runtime_url});}
      catch(error){if(!current())return;throw error;}
      if(!current())return;

      //create the rpc message channel
      let msg_channel = new MessageChannel();
      rpc.attach_host(msg_channel.port1, frame_id);
      rpc.set_host(iframe_element, msg_channel.port2);

      //create additional rpc target for sending the html
      let msg_channel_2 = new MessageChannel();
      let rpc_target = new rpc.RPCTarget(msg_channel_2.port1);
      active_target=rpc_target;
      // This second channel only acknowledges page installation. A child must
      // not invoke its parent's eval/HTML handlers or forward attachments on it.
      rpc_target.onmessage=(event,target)=>{
        if(event.data?.type==='reply')return rpc.message_listener(event,target);
        for(const port of event.ports)port.close();
      };
      msg_channel_2.port1.start();
      rpc.set_host(iframe_element, msg_channel_2.port2);
      const send_page=options=>rpc.call_procedure(rpc_target,'html',[options],{signal:controller.signal});

      iframe_url=final_url;
      const sandbox=iframe_element.getAttribute('sandbox'),opaque=sandbox!==null&&!sandbox_tokens(sandbox).has('allow-same-origin');
      const state = await register(loader.frame_id, frame_id, final_url, {history_mode:navigation.history_mode,opaque,sandbox,window_name:initial_name,srcdoc:inline});
      registered = true;
      window_name=state.window_name;opaque_origin=state.message_origin==='null';
      loader.child_names.set(frame_id,value=>{window_name=value;});
      loader.child_urls.set(frame_id,value=>{iframe_url=value;});
      if(!current())return;
      loader.child_navigators.set(frame_id, fetch_src);
      try {
        await send_page({
          url: final_url,
          html: html,
          frame_id: frame_id,
          error: error,
          ...state,
          referrer_policy,document_referrer,
          inherited_base_url,
          settings: {allow_js:loader.site_settings.allow_js!==false&&(sandbox===null||sandbox_tokens(sandbox).has('allow-scripts'))},
          default_settings: loader.default_settings,
          version: loader.version,
          is_iframe: true,
          message_parent:child_message_parent(message_token),
          message_origin:state.message_origin
        });
      }
      catch (error) {
        if(!current())return;
        let error_msg = util.format_error(error);
        await send_page({
          url: final_url,
          html: html,
          frame_id: frame_id,
          error: error_msg,
          local_storage: undefined,
          settings: {},
          default_settings: loader.default_settings,
          version: loader.version
        });
      }

      if(current()){try{iframe_element.dispatchEvent(new Event("load"));}finally{release_load();}}
    });
    commit=installation.catch(()=>{});
    return installation.catch(error=>{if(current()){release_load();throw error;}});
  }

  set_src=value=>{
      authored_src=value;
      authored.set('src',value);
      if(authored.get('srcdoc')!==null){render_media_attribute(iframe_element,'src','');return;}
      let remote=false;
      try{remote=util.url_is_http(value);}catch{}
      if (!remote || !value){
        retire();
        runtime_sandbox=false;render_sandbox();
        render_media_attribute(iframe_element,'src',value??'');
      }
      else {
        runtime_sandbox=true;render_sandbox();
        render_media_attribute(iframe_element,'src','');
        fetch_src(value).catch(console.error);
      }
  };
  intercept_property(iframe_element,'src',{get:source_url,set(value){set_src(`${value}`);}});
  intercept_iframe_window(iframe_element,()=>iframe_url,(url,history_mode,form_data,navigation)=>{
    return fetch_src(url,form_data,{...navigation,history_mode});
  },message_token,{id:frame_id,name:()=>window_name,opaque:()=>opaque_origin,origin:()=>iframe_url.startsWith('about:srcdoc')?ctx.origin:new URL(iframe_url).origin});
  let lifecycle_ready=false;
  track_iframe(iframe_element,{
    disconnect(){
      retire();
      // A reinserted element must not auto-load its old physical runtime before
      // the authored URL is relayed again. Keep native data/blob sources intact.
      let remote=false;
      try{remote=!authored_src||util.url_is_http(authored_src);}catch{}
      if(remote)render_media_attribute(iframe_element,'src','');
    },
    connect(){
      initial_name=window_name=iframe_element.name;opaque_origin=false;
      if(!lifecycle_ready)return;
      if(authored.get('srcdoc')!==null){fetch_src('about:srcdoc',null,{srcdoc:true}).catch(console.error);return;}
      if(!authored_src)return;
      let remote=false;try{remote=util.url_is_http(authored_src);}catch{}
      if(remote)fetch_src(authored_src).catch(console.error);
    }
  });
  lifecycle_ready=true;
  if(authored.get('srcdoc')!==null){fetch_src('about:srcdoc',null,{srcdoc:true}).catch(console.error);return;}
  if (!iframe_src || iframe_src.startsWith("data:") || iframe_src.startsWith("blob:")) {
    return;
  }
  iframe_element.src = authored_src;
}
import {listen_runtime} from '../runtime_events.mjs';
