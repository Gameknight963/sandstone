import { ctx, convert_url, intercept_property, proxy_function } from "../context.mjs";
import * as network from "../network.mjs";
import * as loader from "../loader.mjs";
import * as util from "../../util.mjs";
import * as rpc from "../../rpc.mjs";
import {parse_referrer_policy} from '../../referrer.mjs';
import {document_referrer_policy} from '../intercept/document.mjs';
import {is_download} from '../../download.mjs';
import {save_response} from '../downloads.mjs';
import {intercept_iframe_window} from '../iframe_window.mjs';
import {child_message_parent} from '../window_messages.mjs';

export function rewrite_iframe(iframe_element) {
  const frame_id = Math.random() + "";
  const message_token=crypto.randomUUID();
  const register = rpc.create_rpc_wrapper(rpc.host, "frame_register");
  const unregister = rpc.create_rpc_wrapper(rpc.host, "frame_unregister");
  let registered = false;
  let iframe_src = iframe_element.src;
  let authored_src = iframe_element.getAttribute('src');
  let iframe_url = "";
  let generation=0,active_request,commit=Promise.resolve();
  const retire=()=>{
    generation++;active_request?.abort();iframe_url='';
    const release=commit.then(async()=>{
      if(registered){await unregister(frame_id);registered=false;}
      loader.child_navigators.delete(frame_id);
    });
    commit=release.catch(console.error);
  };

  let fetch_src = async (value, form_data = null, navigation = {}) => {
    const target_url=convert_url(value,ctx.document.baseURI);
    const revision=++generation;
    active_request?.abort();
    const controller=active_request=new AbortController();
    const current=()=>revision===generation;
    const previous_url=iframe_url;
    //download the proxied html
    iframe_element.setAttribute("__src", value);
    console.log("navigating iframe to", target_url);
    let final_url = target_url;
    let error; //possible network error
    let html;
    let referrer_policy, document_referrer;
    try {
      let response = await network.fetch(target_url, {
        signal:controller.signal,
        mode:'navigate',sandstone_frame_id:navigation.from_child ? frame_id : loader.frame_id,
        cache:navigation.history_mode === 'reload' ? 'no-cache' : 'default',
        referrerPolicy:navigation.referrerPolicy || iframe_element.referrerPolicy || document_referrer_policy(),
        ...(form_data ? {
        method: "POST", headers: form_data.headers || {"Content-Type": form_data.enctype}, body: form_data.body
      } : {})});
      if(!current())return;
      if(is_download(response.headers)){
        try{const filename=await save_response(response);return current()?{download:true,filename}:undefined;}
        catch(error){if(!current())return;console.error(error);return {download:true};}
        finally{if(current())iframe_element.setAttribute('__src',previous_url);}
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
      let loader_blob = new Blob([loader.frame_html], {type: "text/html"});
      const runtime_url=network.create_blob_url(loader_blob);
      await new Promise((resolve) => {
        const cleanup=()=>{iframe_element.removeEventListener('load',loaded);controller.signal.removeEventListener('abort',aborted);};
        const aborted=()=>{cleanup();resolve();};
        const loaded=event=>{
          event.stopImmediatePropagation();
          cleanup();resolve();
        };
        iframe_element.addEventListener('load',loaded);
        controller.signal.addEventListener('abort',aborted,{once:true});
        src_descriptor.set.call(iframe_element, runtime_url);
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
      rpc_target.onmessage = rpc.message_listener;
      msg_channel.port1.start();
      rpc.set_host(iframe_element, msg_channel_2.port2);
      const send_page=options=>rpc.call_procedure(rpc_target,'html',[options],{signal:controller.signal});

      iframe_url=final_url;
      const opaque=iframe_element.hasAttribute('sandbox')&&!iframe_element.sandbox.contains('allow-same-origin');
      const state = await register(loader.frame_id, frame_id, final_url, {history_mode:navigation.history_mode,opaque});
      registered = true;
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
          settings: {},
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

      if(current())iframe_element.dispatchEvent(new Event("load"));
    });
    commit=installation.catch(()=>{});
    return installation.catch(error=>{if(current())throw error;});
  }

  let src_descriptor = intercept_property(iframe_element, "src", {
    get() {
      if(authored_src===null)return '';
      try{return convert_url(authored_src,ctx.document.baseURI);}catch{return authored_src;}
    },
    set(value) {
      value=`${value}`;
      authored_src=value;
      let remote=false;
      try{remote=util.url_is_http(value);}catch{}
      if (!remote || !value){
        retire();
        src_descriptor.set.call(iframe_element, value);
      }
      else {
        src_descriptor.set.call(iframe_element, "");
        fetch_src(value).catch(console.error);
      }
    }
  });
  intercept_iframe_window(iframe_element,()=>iframe_url,(url,history_mode)=>{
    fetch_src(url,null,{history_mode}).catch(console.error);
  },message_token);
  proxy_function(iframe_element, "setAttribute", (target, this_arg, args) => {
    if(this_arg!==iframe_element||args.length<2)return Reflect.apply(target,this_arg,args);
    const name=`${args[0]}`;
    if (name.toLowerCase() === "src")  {
      iframe_element.src = args[1];
      return;
    }
    return Reflect.apply(target, this_arg, [name,...args.slice(1)]);
  })
  for(const method of ['getAttribute','hasAttribute'])proxy_function(iframe_element,method,(target,receiver,args)=>{
    if(receiver!==iframe_element||!args.length)return Reflect.apply(target,receiver,args);
    const name=`${args[0]}`;
    if(name.toLowerCase()==='src')return method==='getAttribute'?authored_src:authored_src!==null;
    return Reflect.apply(target,receiver,[name,...args.slice(1)]);
  });
  proxy_function(iframe_element,'removeAttribute',(target,receiver,args)=>{
    if(receiver!==iframe_element||!args.length)return Reflect.apply(target,receiver,args);
    const name=`${args[0]}`;
    if(name.toLowerCase()==='src'){authored_src=null;retire();}
    return Reflect.apply(target,receiver,[name,...args.slice(1)]);
  });

  if (!iframe_src || iframe_src.startsWith("data:") || iframe_src.startsWith("blob:")) {
    return;
  }
  iframe_element.src = authored_src;
}
