import { ctx, convert_url, intercept_property, proxy_function } from "../context.mjs";
import * as network from "../network.mjs";
import * as loader from "../loader.mjs";
import * as util from "../../util.mjs";
import * as rpc from "../../rpc.mjs";
import {parse_referrer_policy} from '../../referrer.mjs';
import {document_referrer_policy} from '../intercept/document.mjs';
import {is_download} from '../../download.mjs';
import {save_response} from '../downloads.mjs';

export function rewrite_iframe(iframe_element) {
  const frame_id = Math.random() + "";
  const register = rpc.create_rpc_wrapper(rpc.host, "frame_register");
  const unregister = rpc.create_rpc_wrapper(rpc.host, "frame_unregister");
  let registered = false;
  let iframe_src = iframe_element.src;
  let iframe_url = "";

  let fetch_src = async (value, form_data = null, navigation = {}) => {
    const previous_url=iframe_url;
    //download the proxied html
    iframe_element.setAttribute("__src", value);
    iframe_url = convert_url(value, ctx.location.href);
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
    iframe_element.src = network.create_blob_url(loader_blob);
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

    const state = await register(loader.frame_id, frame_id, final_url);
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
        is_iframe: true
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
      return iframe_url || src_descriptor.get.call(iframe_element);
    },
    set(value) {
      if (!util.url_is_http(value) || !value)
        src_descriptor.set.call(iframe_element, value);
      else {
        iframe_element.src = "";
        fetch_src(value);
      }
    }
  });
  proxy_function(iframe_element, "setAttribute", (target, this_arg, args) => {
    if (args[0] === "src")  {
      iframe_element.src = args[1];
      return;
    }
    return Reflect.apply(target, this_arg, args);
  })

  if (!iframe_src || iframe_src.startsWith("data:") || iframe_src.startsWith("blob:")) {
    return;
  }
  iframe_element.src = iframe_src;
}
