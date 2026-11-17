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

export function rewrite_iframe(iframe_element) {
  const frame_id = Math.random() + "";
  const message_token=crypto.randomUUID();
  const register = rpc.create_rpc_wrapper(rpc.host, "frame_register");
  const unregister = rpc.create_rpc_wrapper(rpc.host, "frame_unregister");
  let registered = false;
  let iframe_src = iframe_element.src;
  let authored_src = iframe_element.getAttribute('src');
  let iframe_url = "";

  let fetch_src = async (value, form_data = null, navigation = {}) => {
    const previous_url=iframe_url;
    //download the proxied html
    iframe_element.setAttribute("__src", value);
    iframe_url = convert_url(value, ctx.document.baseURI);
    console.log("navigating iframe to", iframe_url);
    let final_url = iframe_url;
    let error; //possible network error
    let html;
    let referrer_policy, document_referrer;
    try {
      let response = await network.fetch(iframe_url, {
        mode:'navigate',sandstone_frame_id:navigation.from_child ? frame_id : loader.frame_id,
        cache:navigation.history_mode === 'reload' ? 'no-cache' : 'default',
        referrerPolicy:navigation.referrerPolicy || iframe_element.referrerPolicy || document_referrer_policy(),
        ...(form_data ? {
        method: "POST", headers: form_data.headers || {"Content-Type": form_data.enctype}, body: form_data.body
      } : {})});
      if(is_download(response.headers)){
        try{return {download:true,filename:await save_response(response)};}
        catch(error){console.error(error);return {download:true};}
        finally{iframe_url=previous_url;iframe_element.setAttribute('__src',previous_url);}
      }
      html = await response.text();
      final_url = response.url;
      referrer_policy = parse_referrer_policy(response.headers.get('referrer-policy'));
      document_referrer = response.request_referrer || '';
    }
    catch (e) {
      error = util.format_error(e);
    }
    if (registered) {await unregister(frame_id, {keep_history: true});registered=false;}
    
    //load the frame runtime
    let loader_blob = new Blob([loader.frame_html], {type: "text/html"});
    src_descriptor.set.call(iframe_element, network.create_blob_url(loader_blob));
    await new Promise((resolve) => {
      iframe_element.addEventListener("load", (event) => {
        event.stopImmediatePropagation();
        resolve();
      }, {once: true});
    })
    
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
    let send_page = rpc.create_rpc_wrapper(rpc_target, "html");

    //load persisted local storage if needed
    let iframe_origin = new URL(iframe_url).origin;
    let local_storage;
    if (iframe_origin === ctx.location.origin)
      local_storage = ctx.localStorage._get_entries();

    iframe_url=final_url;
    const state = await register(loader.frame_id, frame_id, final_url, {history_mode:navigation.history_mode});
    registered = true;
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
        message_parent:{token:message_token},
        message_origin:iframe_element.hasAttribute('sandbox')&&!iframe_element.sandbox.contains('allow-same-origin')?'null':undefined
      });
    }
    catch (error) {
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

    iframe_element.dispatchEvent(new Event("load"));
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
      if (!remote || !value)
        src_descriptor.set.call(iframe_element, value);
      else {
        src_descriptor.set.call(iframe_element, "");
        fetch_src(value);
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
    if(name.toLowerCase()==='src')authored_src=null;
    return Reflect.apply(target,receiver,[name,...args.slice(1)]);
  });

  if (!iframe_src || iframe_src.startsWith("data:") || iframe_src.startsWith("blob:")) {
    return;
  }
  iframe_element.src = authored_src;
}
