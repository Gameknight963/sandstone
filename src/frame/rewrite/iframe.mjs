import { ctx, convert_url, intercept_property } from "../context.mjs";
import * as network from "../network.mjs";
import * as loader from "../loader.mjs";
import * as util from "../../util.mjs";
import * as rpc from "../../rpc.mjs";
import {parse_referrer_policy,request_referrer} from '../../referrer.mjs';
import {document_referrer_policy} from '../intercept/document.mjs';
import {is_download} from '../../download.mjs';
import {save_response} from '../downloads.mjs';
import {intercept_iframe_window,native_frame_window,iframe_window} from '../iframe_window.mjs';
import {child_message_parent} from '../window_messages.mjs';
import {track_iframe,reconcile_iframes} from '../iframe_lifecycle.mjs';
import {sandbox_tokens,navigation_sandbox as navigation_flags} from '../../navigation_policy.mjs';
import {resource_attribute} from '../resource_attributes.mjs';
import {register_media_attributes,render_media_attribute,render_internal_media_attribute,with_internal_media_attribute,media_attribute_mirror,raw_media_attribute} from '../media_attributes.mjs';
import {iframe_focus_policy} from '../iframe_focus_policy.mjs';
import {delay_script_load} from '../script_lifetime.mjs';
import {bootstrap_html,bootstrap_xml,create_bootstrap_nonce,runtime_seed} from '../../bootstrap.mjs';
import {on_shadow_root} from '../shadow_roots.mjs';
import {cookie_snapshot} from '../polyfill/cookie.mjs';
import {storage_entries} from '../polyfill/storage.mjs';
import {service_worker_snapshot} from '../polyfill/service_worker.mjs';
import {navigation_activation} from '../user_activation.mjs';
import {decode_document_response} from '../../text_encoding.mjs';
import {native_dom} from '../dom_operations.mjs';
import {mime_essence,xml_document_type} from '../../mime.mjs';
import {navigate_target} from '../navigation_targets.mjs';
import {javascript_document_shell} from '../document_shell.mjs';
import {window_runtime_context} from '../runtime_context.mjs';
import {runtime_message,stop_runtime_message,unlisten_runtime} from '../runtime_events.mjs';
import {internal_attribute_mutation} from '../intercept/mutation_observer.mjs';

const relayed_source=value=>util.url_is_http(value)||/^(?:blob|data):/i.test(String(value));

const inline_frames=new WeakMap(),sandbox_lists=new WeakMap();
const runtime_loads=new WeakMap();
// The physical JavaScript URL can be replayed when an iframe is moved or
// reinserted. Keep a stable dispatcher, with weak element ownership, rather
// than leaving a consumed one-use function name in its native src attribute.
const initial_frames=new Map(),initial_callbacks=new WeakMap();
const initial_dispatch=globalThis.document?'__sandstone_initial_'+create_bootstrap_nonce():undefined;
const initial_finalizer=globalThis.FinalizationRegistry&&new FinalizationRegistry(ids=>{for(const id of ids)initial_frames.delete(id);});
if(initial_dispatch)Object.defineProperty(globalThis,initial_dispatch,{value(target,id,phase){
  const element=initial_frames.get(id)?.deref();
  return element&&initial_callbacks.get(element)?.get(id)?.(target,phase);
}});
if(initial_dispatch)listen_runtime(globalThis,'message',event=>{
  const message=runtime_message(event,'data');
  if(!event.isTrusted||!message||message.sandstone_initial_document!==1)return;
  const element=initial_frames.get(message.id)?.deref(),callback=element&&initial_callbacks.get(element)?.get(message.id);
  if(!callback||callback.nonce!==message.nonce||runtime_message(event,'source')!==native_frame_window(element))return;
  stop_runtime_message(event);for(const port of runtime_message(event,'ports')||[])port.close();
  callback(native_frame_window(element),1);
},true);
// Intercept physical runtime loads before author capture listeners, including
// listeners attached before the iframe enters the document.
const capture_runtime_load=event=>{if(event.isTrusted)runtime_loads.get(event.target)?.(event);};
if(globalThis.document)listen_runtime(document,'load',capture_runtime_load,true);
on_shadow_root(root=>listen_runtime(root,'load',capture_runtime_load,true));
const inline_descriptor=globalThis.HTMLIFrameElement&&Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'srcdoc');
const source_descriptor=globalThis.HTMLIFrameElement&&Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'src');
const loading_descriptor=globalThis.HTMLIFrameElement&&Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'loading');
const sandbox_descriptor=globalThis.HTMLIFrameElement&&Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'sandbox');
const allow_descriptor=globalThis.HTMLIFrameElement&&Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'allow');
const policy_descriptor=globalThis.HTMLIFrameElement&&Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'featurePolicy');
const focus_allowlist=globalThis.document?.featurePolicy&&Object.getPrototypeOf(document.featurePolicy).getAllowlistForFeature;
if(allow_descriptor)Object.defineProperty(HTMLIFrameElement.prototype,'allow',{...allow_descriptor,
  get(){const state=inline_frames.get(this);return state?state.allow():allow_descriptor.get.call(this);},
  set(value){const state=inline_frames.get(this);return state?state.set_allow(`${value}`):allow_descriptor.set.call(this,value);}
});
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
  const authored=new Map(['src','srcdoc','sandbox','allow'].map(key=>[key,iframe_element.getAttribute(key)]));
  let document_sandbox=authored.get('sandbox');
  const javascript_source=(value=authored_src)=>{try{const url=convert_url(value,ctx.document.baseURI,loader.character_encoding);if(url.startsWith('javascript:'))return url;}catch{}};
  let javascript_revision=0,pending_javascript=javascript_source()?{url:javascript_source(),initial:true}:null,blank_initialization;
  const javascript_tasks=new Set();
  function supersede_javascript(){
    javascript_revision++;pending_javascript=null;clear_initial_javascript();
    // A discarded realm may never reply to its initial readiness requests.
    for(const task of javascript_tasks)task.cancel();
    return javascript_revision;
  }
  let initial_javascript,initial_source,initial_result_pending,blank_options,blank_nonce,initial_tracking=false;
  const initial_ids=new Set();
  const forget_initial_id=id=>{initial_frames.delete(id);initial_ids.delete(id);};
  const blank_url=()=>{
    if(authored.get('srcdoc')!==null)return;
    if(javascript_source())return 'about:blank';
    if(!authored_src)return 'about:blank';
    try{const url=new URL(authored_src,ctx.document.baseURI);if(url.protocol==='about:'&&url.pathname==='blank'&&!url.search)return url.href;}catch{}
  };
  let physical_inline='',finish_load,active_target,native_runtime_load,set_src;
  let policy_url=ctx.location.href;
  const render_focus=()=>{
    render_internal_media_attribute(iframe_element,'allow',authored.get('allow'));
    let defaultAll=false;
    try{defaultAll=focus_allowlist?.call(policy_descriptor.get.call(iframe_element),'focus-without-user-activation').includes('*')||false;}catch{}
    let source=ctx.location.href;
    if(authored_src&&authored.get('srcdoc')===null)try{source=new URL(authored_src,ctx.document.baseURI).href;}catch{source='about:invalid';}
    render_internal_media_attribute(iframe_element,'allow',iframe_focus_policy(authored.get('allow'),{
      parent:ctx.origin,document:policy_url,source,
      sandboxed:loader.sandboxed_context||document_sandbox!==null,
      opaque:ctx.origin==='null'||document_sandbox!==null&&!sandbox_tokens(document_sandbox).has('allow-same-origin'),defaultAll
    }));
  };
  let runtime_sandbox=authored.get('srcdoc')!==null||!!blank_url();
  let ensure_blank=()=>false,initializing_blank=false,blank_ready=false,blank_runtime,blank_load_pending=true;
  runtime_loads.set(iframe_element,event=>{
    if(!native_runtime_load&&blank_load_pending&&blank_url()&&!initializing_blank&&ensure_blank(native_frame_window(iframe_element))&&blank_runtime?.loader.pristine_blank){blank_load_pending=false;return;}
    if(event.isTrusted&&(runtime_sandbox||iframe_url||native_runtime_load)){event.stopImmediatePropagation();native_runtime_load?.(event);}
  });
  const release_load=()=>{finish_load?.();finish_load=undefined;};
  const render_sandbox=(internal=true)=>{
    const value=authored.get('sandbox');
    const render=()=>render_media_attribute(iframe_element,'sandbox',value===null?'':runtime_sandbox?value+' allow-scripts':value);
    return internal?internal_attribute_mutation(iframe_element,'sandbox',render):render();
  };
  const update_inline=(key,value)=>{
    if(key==='src')return set_src(value);
    if(key==='srcdoc')clear_initial_javascript();
    if(key==='allow')render_internal_media_attribute(iframe_element,key,authored.get(key));
    authored.set(key,value);
    if(key==='sandbox'){
      const pending=!!initial_javascript;
      if(pending&&!iframe_element.isConnected)clear_initial_javascript();
      render_sandbox(false);render_focus();
      if(!iframe_element.isConnected&&javascript_source()){
        if(!prepare_initial_javascript()&&pending)render_media_attribute(iframe_element,'src','');
      }
      return;
    }
    if(key==='allow'){render_media_attribute(iframe_element,key,value);render_focus();return;}
    // Never install authored markup in the physical document.
    render_media_attribute(iframe_element,'srcdoc',value===null?'':physical_inline);
    if(value!==null){runtime_sandbox=true;render_sandbox();fetch_src('about:srcdoc',null,{srcdoc:true}).catch(console.error);}
    else {physical_inline='';set_src(authored_src);}
  };
  register_media_attributes(iframe_element,authored,update_inline,key=>update_inline(key,null));
  const mirror=media_attribute_mirror(iframe_element),sandbox=sandbox_descriptor.get.call(mirror);
  const source_url=()=>{if(authored_src===null)return '';try{return convert_url(authored_src,ctx.document.baseURI,loader.character_encoding);}catch{return authored_src;}};
  inline_frames.set(iframe_element,{source:()=>authored.get('srcdoc')??'',set:value=>update_inline('srcdoc',value),url:source_url,set_src:value=>set_src(value),sandbox,set_sandbox:value=>update_inline('sandbox',value),allow:()=>authored.get('allow')??'',set_allow:value=>update_inline('allow',value)});
  sandbox_lists.set(sandbox,()=>update_inline('sandbox',mirror.getAttribute('sandbox')));
  for(const key of authored.keys())resource_attribute(iframe_element,key,()=>authored.get(key));
  render_sandbox();
  render_focus();
  if(javascript_source())render_media_attribute(iframe_element,'src','');
  if(authored.get('srcdoc')!==null){render_media_attribute(iframe_element,'src','');render_media_attribute(iframe_element,'srcdoc','');}
  const authored_internal=iframe_element.getAttribute('__src');
  resource_attribute(iframe_element,'src',()=>authored_src);
  resource_attribute(iframe_element,'__src',()=>authored_internal);
  let initial_name=iframe_element.name;
  let window_name=initial_name,opaque_origin=false;
  let iframe_url = "";
  let generation=0,active_request,commit=Promise.resolve(),context_ready=commit;
  async function wait_javascript(signal,revision){
    let aborted;
    const cancelled=new Promise(resolve=>{aborted=resolve;signal.addEventListener('abort',aborted,{once:true});});
    try{
      while(!signal.aborted){
        const pending=[...javascript_tasks].filter(task=>task.generation===revision).map(task=>task.completed);
        if(!pending.length)return;
        await Promise.race([Promise.all(pending),cancelled]);
      }
    }
    finally{signal.removeEventListener('abort',aborted);}
  }
  const retire=()=>{
    initial_result_pending=undefined;
    generation++;active_request?.abort();iframe_url='';active_target=undefined;blank_ready=false;blank_load_pending=true;release_load();
    const closing=generation;
    const release=commit.then(async()=>{
      if(registered){await unregister(frame_id,{keep_navigation:generation!==closing});registered=false;}
      else if(generation===closing)await unregister(frame_id);
      if(generation===closing){loader.child_navigators.delete(frame_id);loader.child_names.delete(frame_id);loader.child_urls.delete(frame_id);}
    });
    commit=release.catch(console.error);
  };

  ensure_blank=target=>{
    if(!initializing_blank)reconcile_iframes(iframe_element);
    if(initial_result_pending?.target===target)return false;
    if(initial_javascript?.phase===1){
      try{if(target.document!==initial_javascript.document)return false;}catch{return false;}
    }
    if(blank_ready){try{if(target.sandstone_frame===blank_runtime)return true;}catch{}blank_ready=false;}
    const url=blank_url();
    if(initializing_blank||native_runtime_load||!url||!iframe_element.isConnected)return false;
    let doc;try{doc=target.document;if(target.sandstone_frame)return false;}catch{return false;}
    if(!doc||!doc.URL.startsWith('about:blank'))return false;
    if(iframe_url)retire();
    const revision=++generation,nonce=create_bootstrap_nonce(),token=create_bootstrap_nonce(),channel=new MessageChannel();
    const current=()=>generation===revision&&iframe_element.isConnected;
    initializing_blank=true;runtime_sandbox=true;iframe_url=url;opaque_origin=ctx.origin==='null';
    try{
      if(!doc.doctype)doc.insertBefore(doc.implementation.createDocumentType('html','',''),doc.documentElement);
      doc.documentElement.innerHTML=bootstrap_html(loader.frame_html,nonce,1);
      const old=doc.querySelector('script'),script=doc.createElement('script');
      script.setAttribute('data-sandstone-bootstrap',old.getAttribute('data-sandstone-bootstrap'));script.textContent=old.textContent;old.replaceWith(script);
      const runtime=target.sandstone_frame;
      blank_runtime=runtime;
      blank_nonce=nonce;
      const document_current=()=>{try{return iframe_element.isConnected&&native_frame_window(iframe_element).sandstone_frame===runtime;}catch{return false;}};
      // The child is usable now. Leave the host end unstarted until registration
      // succeeds so early requests queue behind their document's capability.
      runtime.rpc.connect_frame_host(channel.port2,nonce);
      const creator_url=loader.cookie_url||loader.url,policy=document_referrer_policy(),sandbox=document_sandbox;
      let local=[],session=[];try{local=storage_entries(ctx.localStorage);session=storage_entries(ctx.sessionStorage);}catch{}
      const options=blank_options={url,frame_id,beacon_context:token,document_origin:ctx.origin,cookie_url:creator_url,
        automatic_features:loader.automatic_features&&(sandbox===null||sandbox_tokens(sandbox).has('allow-scripts')),
        sandboxed_context:loader.sandboxed_context||sandbox!==null,
        navigation_sandbox:navigation_flags(loader.navigation_sandbox,sandbox),
        service_worker_state:service_worker_snapshot(),
        inherited_base_url:ctx.document.baseURI,document_referrer:javascript_source()?'':loader.url.startsWith('blob:')?loader.url:request_referrer(creator_url,creator_url,policy),referrer_policy:policy,
        message_origin:ctx.origin,message_parent:child_message_parent(message_token),is_iframe:true,window_name:window_name,
        crypto_available:loader.crypto_available,local_storage:local,session_storage:session,cookies:cookie_snapshot(),
        cookie_cross_site:loader.cookie_cross_site,settings:{allow_js:loader.site_settings.allow_js!==false&&(sandbox===null||sandbox_tokens(sandbox).has('allow-scripts'))},
        default_settings:loader.default_settings,version:loader.version};
      const ready=runtime.loader.initialize_blank(options,completion=>{if(document_current()&&(!javascript_source()||completion?.written))iframe_element.dispatchEvent(new Event('load'));},value=>{
          if(!document_current())return;
          if(active_request&&!active_request.signal.aborted){active_request.abort();generation++;}
          iframe_url=value;
        });
      ready.catch(error=>{if(current()&&error?.name!=='AbortError')console.error(error);});
      blank_initialization=ready;
      blank_ready=true;
      // A child can post to its parent before author code reads contentWindow.
      // Register its WindowProxy now so those messages unwrap normally.
      iframe_window(iframe_element);
      loader.child_names.set(frame_id,value=>{window_name=value;});
      loader.child_urls.set(frame_id,(value,context)=>{if(!context||context===token)iframe_url=value;});
      loader.child_navigators.set(frame_id,fetch_src);
      const registration=commit.then(async()=>{
        if(registered){await unregister(frame_id);registered=false;}
        await register(loader.frame_id,frame_id,url,{blank:true,creator_url,beacon_context:token,sandbox,opaque:opaque_origin,window_name});
        // A removed document can still have accepted unload requests queued.
        // Attach before the serialized unregister retires its context.
        registered=true;rpc.attach_host(channel.port1,frame_id);
      });
      commit=registration.catch(error=>{channel.port1.close();channel.port2.close();if(current())console.error(error);});
      context_ready=Promise.all([commit,ready]);context_ready.catch(()=>{});
      return true;
    }catch(error){channel.port1.close();channel.port2.close();iframe_url='';throw error;}
    finally{initializing_blank=false;}
  };

  async function document_barrier(port,token,signal){
    // A fresh native Window no longer runs the original realm's port listener.
    // Receive only this ordered reply in the still-active parent realm.
    const receive=event=>{if(runtime_message(event,'data')?.type==='reply')rpc.message_listener(event);};
    listen_runtime(port,'message',receive);
    try{return await rpc.call_procedure(port,'cookies_ready',[frame_id,token],{signal});}
    finally{unlisten_runtime(port,'message',receive);}
  }

  function clear_initial_javascript(only){
    const callbacks=initial_callbacks.get(iframe_element);
    for(const [id,callback] of callbacks||[]){
      if(only&&callback.state!==only)continue;
      const state=callback.state;
      try{if(state.target)delete state.target[state.child_key];}catch{}
      callbacks.delete(id);
      if(id!==initial_source?.id)forget_initial_id(id);
      if(initial_javascript===state)initial_javascript=undefined;
    }
    if(!callbacks?.size)initial_callbacks.delete(iframe_element);
  }
  function prepare_initial_javascript(new_source=false){
    const url=javascript_source(),sandbox=authored.get('sandbox'),tokens=sandbox_tokens(sandbox);
    if(iframe_url||!url||!initial_dispatch||typeof WeakRef!=='function'||authored.get('srcdoc')!==null||ctx.origin==='null'||loader.site_settings.allow_js===false||sandbox!==null&&(!tokens.has('allow-scripts')||!tokens.has('allow-same-origin')))return false;
    if(initial_javascript&&!new_source)return true;
    if(iframe_element.isConnected){
      // Reconnection is observed after insertion for native move operations.
      // Its already-queued src must be our dispatcher, in a fresh blank realm.
      try{if(raw_media_attribute(iframe_element,'src')!==initial_source?.native_src||native_frame_window(iframe_element).sandstone_frame)return false;}catch{return false;}
    }
    if(new_source||!initial_source||initial_source.url!==url){
      if(initial_source&&!initial_callbacks.get(iframe_element)?.has(initial_source.id))forget_initial_id(initial_source.id);
      const id=create_bootstrap_nonce();
      initial_source={id,url,native_src:'javascript:parent['+JSON.stringify(initial_dispatch)+'](this,'+JSON.stringify(id)+',0)'};
    }
    const {id,native_src}=initial_source;
    if(!initial_frames.has(id)){
      initial_frames.set(id,new WeakRef(iframe_element));initial_ids.add(id);
      if(!initial_tracking){initial_finalizer?.register(iframe_element,initial_ids);initial_tracking=true;}
    }
    let callbacks=initial_callbacks.get(iframe_element);
    if(!callbacks)initial_callbacks.set(iframe_element,callbacks=new Map());
    const revision=javascript_revision,state=initial_javascript={revision,phase:0};
    const current=target=>callbacks.get(id)?.state===state&&revision===javascript_revision&&(state.generation===undefined||state.generation===generation)&&iframe_element.isConnected&&native_frame_window(iframe_element)===target;
    const callback=(target,phase)=>{
      if(!current(target)||phase!==state.phase)return;
      if(phase===0){
        if(!ensure_blank(target)){clear_initial_javascript(state);return;}
        state.generation=generation;
        pending_javascript=null;blank_load_pending=false;
        const runtime=target.sandstone_frame;
        state.runtime=runtime;state.document=target.document;
        state.target=target;state.child_key='__sandstone_replacement_'+create_bootstrap_nonce();
        callback.nonce=state.child_key;
        Object.defineProperty(target,state.child_key,{configurable:true,value:()=>globalThis[initial_dispatch](target,id,1)});
        const result=runtime.javascript_navigation.evaluate_javascript_url(url);
        if(!current(target))return;
        if(typeof result.html!=='string'){
          const ready=Promise.all([commit,blank_initialization]);clear_initial_javascript(state);
          ready.then(()=>{if(initial_source?.id===id&&revision===javascript_revision&&iframe_element.isConnected)iframe_element.dispatchEvent(new Event('load'));}).catch(error=>{if(error?.name!=='AbortError')console.error(error);});
          return;
        }
        state.result=result;state.phase=1;initial_javascript=state;
        // Only the fixed shell and this one-use private callback reach the
        // native parser. Authored resource-bearing HTML stays in the broker.
        const invoke='this['+JSON.stringify(state.child_key)+']';
        const message=JSON.stringify({sandstone_initial_document:1,id,nonce:state.child_key});
        return javascript_document_shell(result.html).replace('<head>','<head><script>if('+invoke+')'+invoke+'();else parent.postMessage('+message+',"*");<\/script>');
      }
      let reused=false;
      try{if(target.document===state.document)return;reused=target.sandstone_frame===state.runtime;}catch{}
      if(!reused){
        // document.open can end the initial-empty-document state during the
        // authored program. The browser then creates a fresh Window for the
        // string result; its shell reports readiness without requiring SOP.
        const runtime=state.runtime,result=state.result,revision_id=generation;
        const old_port=runtime.rpc.host.target,old_token=runtime.loader.beacon_context;
        const url=runtime.loader.url,creator_url=blank_options.cookie_url;
        const pending=initial_result_pending={target};
        // The native string result destroyed this realm. Its initialization
        // promise can no longer receive replies on the old document's port.
        blank_initialization=undefined;blank_ready=false;context_ready=commit;
        clear_initial_javascript();
        commit.then(async()=>{
          await document_barrier(old_port,old_token);
          if(revision===javascript_revision&&generation===revision_id&&iframe_element.isConnected)await fetch_src(url,null,{history_mode:'replace',result_document:true},{...result.document,html:result.html,creator_url});
        }).catch(error=>{if(revision===javascript_revision&&iframe_element.isConnected&&error?.name!=='AbortError')console.error(error);}).finally(()=>{if(initial_result_pending===pending)initial_result_pending=undefined;});
        return;
      }
      const runtime=state.runtime,result=state.result,old_ready=blank_initialization,old_commit=commit;
      const old_port=runtime.rpc.host.target,old_token=runtime.loader.beacon_context;
      const channel=new MessageChannel(),token=create_bootstrap_nonce(),generation_id=++generation;
      active_request?.abort();
      const controller=active_request=new AbortController();
      clear_initial_javascript();
      const live=()=>revision===javascript_revision&&generation===generation_id&&iframe_element.isConnected&&native_frame_window(iframe_element)===target&&target.sandstone_frame===runtime;
      runtime.rpc.connect_reused_frame_host(channel.port2,blank_nonce);
      iframe_url=runtime.loader.url;
      const options={...blank_options,...result.document,url:iframe_url,html:result.html,beacon_context:token,cookie_url:'about:blank',window_name:target.name,signal:controller.signal,before_parse:()=>wait_javascript(controller.signal,generation_id)};
      // This updates the document view synchronously, before queued authored
      // microtasks. Loading waits on the replacement's unstarted host channel.
      const loaded=runtime.loader.load_reused_document(options);
      loaded.catch(()=>{});blank_initialization=loaded;
      loader.child_urls.set(frame_id,(value,context)=>{if(!context||context===token)iframe_url=value;});
      const installation=(async()=>{
        await old_commit;await old_ready;
        if(!live())return;
        // Order all original-document cookie/history writes before retiring it.
        await document_barrier(old_port,old_token,controller.signal);
        if(!live())return;
        if(registered){await unregister(frame_id,{keep_history:true});registered=false;}
        if(!live())return;
        await register(loader.frame_id,frame_id,iframe_url,{blank:true,creator_url:blank_options.cookie_url,beacon_context:token,sandbox:document_sandbox,window_name:target.name,history_mode:'replace',document_result:true});
        registered=true;rpc.attach_host(channel.port1,frame_id);
      })();
      commit=installation.catch(error=>{channel.port1.close();channel.port2.close();if(live()&&error?.name!=='AbortError')console.error(error);});
      context_ready=Promise.all([commit,runtime.loader.document_prepared()]);context_ready.catch(()=>{});
      installation.then(()=>loaded).then(()=>{if(live())iframe_element.dispatchEvent(new Event('load'));}).catch(error=>{if(live()&&error?.name!=='AbortError')console.error(error);});
    };
    callback.state=state;callbacks.set(id,callback);
    if(raw_media_attribute(iframe_element,'src')!==native_src)render_media_attribute(iframe_element,'src',native_src);
    return true;
  }

  async function run_javascript(pending,revision){
    if(!iframe_element.isConnected)return;
    let finish,cancel;
    const completed=new Promise(resolve=>{finish=resolve;});
    const cancelled=new Promise(resolve=>{cancel=resolve;});
    const task={generation,completed,cancel};javascript_tasks.add(task);
    try{
      if(!iframe_url)ensure_blank(native_frame_window(iframe_element));
      task.generation=generation;
      let document;
      try{document=native_frame_window(iframe_element).document;}catch{}
      const same_document=()=>{try{return !document||native_frame_window(iframe_element).document===document;}catch{return !document;}};
      // A replacement Window needs its own URL, origin and storage capability
      // before it can evaluate a queued JavaScript navigation.
      let ready;
      do{ready=context_ready;await Promise.race([ready,cancelled]);if(revision!==javascript_revision||!iframe_element.isConnected||!same_document())return;}while(ready!==context_ready);
      // Evaluate without waiting for parser-blocking scripts. A string result
      // starts the replacement and cancels the old load in fetch_src; other
      // completion values leave the original document loading normally.
      const result=await navigate_target(pending.url,{id:frame_id});
      if(pending.initial&&result?.executed&&revision===javascript_revision&&iframe_element.isConnected&&!result.replaced&&blank_load_pending){blank_load_pending=false;iframe_element.dispatchEvent(new Event('load'));}
      return result;
    }finally{javascript_tasks.delete(task);finish();}
  }
  function queue_javascript(){
    if(!pending_javascript||!iframe_element.isConnected)return;
    const pending=pending_javascript;pending_javascript=null;
    run_javascript(pending,javascript_revision).catch(console.error);
  }

  let fetch_src = async (value, form_data = null, navigation = {}, document_result) => {
    navigation={activation:navigation_activation(),...navigation};
    if(!iframe_element.isConnected||native_dom.owner.call(iframe_element)!==document)return;
    const javascript=javascript_source(value);
    if(javascript)return run_javascript({url:javascript,initial:false},javascript_revision);
    if(!document_result)initial_result_pending=undefined;
    const inline=navigation.srcdoc||new URL(value,ctx.document.baseURI).href.split('#')[0]==='about:srcdoc';
    if(inline&&authored.get('srcdoc')===null)return;
    const target_url=convert_url(value,ctx.document.baseURI,loader.character_encoding);
    // A readable child's pushState is synchronous; its URL notification to the
    // parent may still be queued when src is assigned in that same task.
    const current_context=active_target&&window_runtime_context(native_frame_window(iframe_element));
    const document_url=current_context?current_context.location.href:iframe_url;
    if(!document_result&&!navigation.srcdoc&&!form_data&&active_target&&navigation.history_mode!=='reload'&&(target_url.includes('#')||navigation.fragment)&&target_url.split('#')[0]===document_url.split('#')[0]){
      return rpc.call_procedure(active_target,'navigate_fragment',[target_url,navigation.history_mode==='replace']);
    }
    // Location and named-target navigations do not pass through the src
    // setter. They must also supersede programs waiting on the old context.
    if(!document_result)supersede_javascript();
    const sandbox=document_result?document_sandbox:authored.get('sandbox');
    const blank_result=!!document_result&&/^about:blank(?:#|$)/.test(target_url);
    const local=/^(?:blob|data):/.test(target_url),blob=target_url.startsWith('blob:');
    runtime_sandbox=true;render_sandbox();
    const inherited_base_url=document_result?document_result.inherited_base_url:inline?ctx.document.baseURI:undefined;
    // Network frames delay their parent's load just like srcdoc. Lazy frames
    // remain nonblocking when scripting enables the browser's lazy-load rules.
    const lazy=loader.site_settings.allow_js!==false&&loading_descriptor?.get?.call(iframe_element)==='lazy';
    if(!lazy&&!finish_load)finish_load=delay_script_load();
    const revision=++generation;
    active_request?.abort();
    const controller=active_request=new AbortController();
    const current=()=>revision===generation&&iframe_element.isConnected&&native_dom.owner.call(iframe_element)===document;
    const previous_url=iframe_url;
    //download the proxied html
    iframe_element.setAttribute("__src", value);
    console.log("navigating iframe to", target_url);
    let final_url = target_url;
    let error; //possible network error
    let html,character_encoding='UTF-8',content_type='text/html';
    const shares_origin=url=>authored.get('srcdoc')===null&&!url.startsWith('data:')&&(blank_result||blob||new URL(url).origin===ctx.origin)&&!(sandbox!==null&&!sandbox_tokens(sandbox).has('allow-same-origin'));
    let referrer_policy, document_referrer,request_metadata_token;
    if(document_result){html=document_result.html;referrer_policy=document_result.referrer_policy;document_referrer=document_result.document_referrer;}
    else if(inline){html=authored.get('srcdoc');referrer_policy=document_referrer_policy();document_referrer=loader.document_referrer;}
    else try {
      let response = await network.fetch(target_url, {
        signal:controller.signal,
        mode:local?'cors':'navigate',sandstone_frame_id:navigation.from_child ? frame_id : loader.frame_id,
        sandstone_navigation_source:navigation.source_context,
        sandstone_navigation_activation:!!navigation.activation?.transient,
        sandstone_navigation_target:frame_id,
        sandstone_navigation_opaque:!!(sandbox!==null&&!sandbox_tokens(sandbox).has('allow-same-origin'))||ctx.origin==='null',
        cache:navigation.history_mode === 'reload' ? 'no-cache' : 'default',
        referrerPolicy:navigation.referrerPolicy || iframe_element.referrerPolicy || document_referrer_policy(),
        ...(form_data ? {
        method: "POST", headers: form_data.headers || {"Content-Type": form_data.enctype}, body: form_data.body
      } : {})});
      if(!current())return;
      content_type=xml_document_type(response.headers.get('content-type'))||'text/html';
      // Opaque/cross-origin XML can use its native parser behind the relay.
      // Shared-origin XML needs a separate native-origin navigation strategy.
      const isolated_xml=content_type!=='text/html'&&!shares_origin(response.url||target_url);
      if(local&&mime_essence(response.headers.get('content-type'))!=='text/html'&&!isolated_xml){
        await response.body?.cancel();if(!current())return;
        retire();runtime_sandbox=false;render_sandbox();
        render_media_attribute(iframe_element,'src',target_url);return;
      }
      if([204,205].includes(response.status)){await response.body?.cancel();iframe_element.setAttribute('__src',previous_url);release_load();return {no_navigation:true};}
      if(is_download(response.headers)){
        try{const filename=await save_response(response);return current()?{download:true,filename}:undefined;}
        catch(error){if(!current())return;console.error(error);return {download:true};}
        finally{if(current()){iframe_element.setAttribute('__src',previous_url);release_load();}}
      }
      const inherited=new URL(response.url||target_url).origin===ctx.origin?loader.character_encoding:undefined;
      const decoded=await decode_document_response(response,{fallbackEncoding:inherited});
      html=decoded.text;character_encoding=decoded.encoding;
      final_url = response.url||target_url;
      referrer_policy = local?document_referrer_policy():parse_referrer_policy(response.headers.get('referrer-policy'));
      document_referrer = local?request_referrer(loader.cookie_url||loader.url,blob&&ctx.origin!=='null'?'blob:'+ctx.origin+'/':target_url,iframe_element.referrerPolicy||document_referrer_policy()):response.request_referrer || '';
      request_metadata_token=network.navigation_metadata(response);
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
      let finish_context;
      context_ready=new Promise(resolve=>{finish_context=resolve;});
      try{
        if (registered) {await unregister(frame_id, {keep_history: true});registered=false;}
        if(!current())return;

        //load the frame runtime
        const bootstrap_nonce=create_bootstrap_nonce();
        document_sandbox=sandbox;
        policy_url=/^about:(?:blank|srcdoc)(?:[?#]|$)/.test(final_url)?ctx.location.href:final_url;render_focus();
        const use_inline=authored.get('srcdoc')!==null;
        const share_origin=shares_origin(final_url);
        const mime=error||share_origin?'text/html':content_type;
        const runtime_source=mime==='text/html'?bootstrap_html(loader.frame_html,bootstrap_nonce,2):bootstrap_xml(loader.runtime_src,mime,bootstrap_nonce,2);
        const runtime_url=use_inline?'about:srcdoc#'+crypto.randomUUID():share_origin?'about:blank?'+crypto.randomUUID():runtime_seed(bootstrap_nonce,{in_place:true,mime});
        const runtime_html=use_inline?runtime_source.replace(/(<head[^>]*>)/i,'$1<script>history.replaceState(null,"",'+JSON.stringify(runtime_url)+');document.currentScript.remove();<\/script>'):undefined;
        await new Promise((resolve) => {
          const cleanup=()=>{if(native_runtime_load===loaded)native_runtime_load=undefined;controller.signal.removeEventListener('abort',aborted);};
          const aborted=()=>{cleanup();resolve();};
          const loaded=event=>{
            event.stopImmediatePropagation();
            if(share_origin){
              let target,doc;
              try{target=native_frame_window(iframe_element);doc=target.document;if(doc.URL!==runtime_url)return;}catch{return;}
              // Populate a fresh inherited-origin document using its pristine
              // DOM methods. Replacing the inert script executes the runtime in
              // the child's own realm without giving it the host's origin.
              if(!doc.doctype)doc.insertBefore(doc.implementation.createDocumentType('html','',''),doc.documentElement);
              doc.documentElement.innerHTML=runtime_source;
              const old=doc.querySelector('script'),script=doc.createElement('script');
              script.setAttribute('data-sandstone-bootstrap',old.getAttribute('data-sandstone-bootstrap'));
              script.textContent=old.textContent;old.replaceWith(script);
            }
            cleanup();resolve();
          };
          native_runtime_load=loaded;
          controller.signal.addEventListener('abort',aborted,{once:true});
          with_internal_media_attribute(iframe_element,'sandbox',sandbox===null?null:sandbox+' allow-scripts',()=>{
            if(use_inline){physical_inline=runtime_html;render_media_attribute(iframe_element,'srcdoc',runtime_html);}
            else if(authored_src!==null)render_media_attribute(iframe_element,'src',runtime_url);
            else native_frame_window(iframe_element).location.href=runtime_url;
          });
        });
        if(!current())return;
        // A load event may belong to the previous document or the blank reset.
        // The reflected src is virtual, so identify the physical runtime explicitly.
        try{
          await rpc.wait_on_frame(iframe_element,{signal:controller.signal,url:runtime_url,nonce:bootstrap_nonce});
          if(!use_inline&&!share_origin){
            const prepared=await rpc.load_frame_runtime(iframe_element,runtime_source,bootstrap_nonce,{signal:controller.signal,mime,in_place_url:runtime_url});
            if(!current())return;
            rpc.commit_frame_runtime(iframe_element,prepared,bootstrap_nonce);
            await rpc.wait_on_frame(iframe_element,{signal:controller.signal,url:prepared,nonce:bootstrap_nonce});
          }
        }
        catch(error){if(!current())return;throw error;}
        if(!current())return;

        //create the rpc message channel
        let msg_channel = new MessageChannel();
        rpc.attach_host(msg_channel.port1, frame_id);
        rpc.set_host(iframe_element, msg_channel.port2,{nonce:bootstrap_nonce});

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
        rpc.set_host(iframe_element, msg_channel_2.port2,{nonce:bootstrap_nonce});
        const send_page=options=>rpc.call_procedure(rpc_target,'html',[options],{signal:controller.signal});

        iframe_url=final_url;
        const opaque=sandbox!==null&&!sandbox_tokens(sandbox).has('allow-same-origin');
        const state = await register(loader.frame_id, frame_id, final_url, {history_mode:navigation.history_mode,opaque,sandbox,window_name:initial_name,srcdoc:inline,blank:blank_result,creator_url:blank_result?document_result.creator_url:undefined,blob,request_metadata_token,document_result:!!document_result});
        registered = true;
        window_name=state.window_name;opaque_origin=state.message_origin==='null';
        loader.child_names.set(frame_id,value=>{window_name=value;});
        loader.child_urls.set(frame_id,(value,context)=>{if(!context||context===state.beacon_context)iframe_url=value;});
        if(!current())return;
        loader.child_navigators.set(frame_id, fetch_src);
        const page_options={
            url: final_url,
            html: html,
            character_encoding,
            frame_id: frame_id,
            error: error,
            ...state,
            referrer_policy,document_referrer,
            inherited_base_url,
            settings: {allow_js:loader.site_settings.allow_js!==false&&(sandbox===null||sandbox_tokens(sandbox).has('allow-scripts'))},
            default_settings: loader.default_settings,
            version: loader.version,
            is_iframe: true,
            automatic_features:loader.automatic_features&&(sandbox===null||sandbox_tokens(sandbox).has('allow-scripts')),
            sandboxed_context:loader.sandboxed_context||sandbox!==null,
            navigation_sandbox:navigation_flags(loader.navigation_sandbox,sandbox),
            message_parent:child_message_parent(message_token),
            message_origin:state.message_origin,
            prepared_context:state.beacon_context
        };
        const {html:page_html,prepared_context,...preparation}=page_options;
        await rpc.call_procedure(rpc_target,'prepare_document',[preparation],{signal:controller.signal});
        finish_context();
        // A string result cancels this load; a non-string completion resumes it
        // after the queued program has run in the prepared document context.
        await wait_javascript(controller.signal,revision);
        if(!current())return;
        try {
          await send_page(page_options);
        }
        catch (error) {
          if(!current())return;
          let error_msg = util.format_error(error);
          await send_page({
            url: final_url,
            html: html,
            frame_id: frame_id,
            prepared_context:state.beacon_context,
            error: error_msg,
            local_storage: undefined,
            settings: {},
            default_settings: loader.default_settings,
            version: loader.version
          });
        }

        if(current()){try{iframe_element.dispatchEvent(new Event("load"));}finally{release_load();}}
        if(navigation.result_document&&current())return {document_context:state.beacon_context,failed:!!error};
      }finally{finish_context();}
    });
    commit=installation.catch(()=>{});
    return installation.catch(error=>{if(current()){release_load();throw error;}});
  }

  set_src=value=>{
      initial_result_pending=undefined;
      pending_javascript=null;
      authored_src=value;
      authored.set('src',value);
      if(authored.get('srcdoc')!==null){render_media_attribute(iframe_element,'src','');return;}
      const javascript=javascript_source();
      if(javascript){
        // Native initial JavaScript navigations queue separately. Changing src
        // must not redirect an already queued dispatcher to the newest source.
        if(!iframe_element.isConnected)clear_initial_javascript();
        runtime_sandbox=true;render_sandbox();
        if(prepare_initial_javascript(true))return;
        // Keep a real Attr for native attribute APIs without replacing the
        // active document. Authored JavaScript stays in the virtual runtime.
        render_media_attribute(iframe_element,'src','javascript:void 0');
        pending_javascript={url:javascript,initial:false};queue_javascript();return;
      }
      clear_initial_javascript();
      let remote=false;
      try{remote=relayed_source(value);}catch{}
      if (!remote || !value){
        supersede_javascript();
        if(blank_url()){
          active_request?.abort();generation++;blank_load_pending=true;
          runtime_sandbox=true;render_sandbox();render_media_attribute(iframe_element,'src',value??'');return;
        }
        retire();
        runtime_sandbox=!!blank_url();render_sandbox();
        render_media_attribute(iframe_element,'src',value??'');
      }
      else {
        runtime_sandbox=true;render_sandbox();
        // Keep a loaded document visible while its next response is fetched.
        // Resetting through about:blank adds an unnecessary origin/process
        // swap and destroys the old document before the navigation commits.
        render_media_attribute(iframe_element,'src','',registered&&!!iframe_url&&raw_media_attribute(iframe_element,'src')!==null);
        fetch_src(value).catch(console.error);
      }
  };
  intercept_property(iframe_element,'src',{get:source_url,set(value){set_src(`${value}`);}});
  intercept_iframe_window(iframe_element,()=>iframe_url,(url,history_mode,form_data,navigation)=>{
    return fetch_src(url,form_data,{...navigation,history_mode});
  },message_token,{id:frame_id,name:()=>window_name,opaque:()=>opaque_origin,prepare:ensure_blank,origin:()=>!iframe_url||/^(?:blob:|about:(?:srcdoc|blank)(?:#|$))/.test(iframe_url)?ctx.origin:new URL(iframe_url).origin});
  let lifecycle_ready=false;
  prepare_initial_javascript();
  track_iframe(iframe_element,{
    disconnect(){
      clear_initial_javascript();
      supersede_javascript();
      retire();
      if(javascript_source()){
        prepare_initial_javascript();return;
      }
      // A reinserted element must not auto-load its old physical runtime before
      // the authored URL is relayed again.
      let remote=false;
      try{remote=!authored_src||relayed_source(authored_src);}catch{}
      if(remote)render_media_attribute(iframe_element,'src','');
    },
    connect(){
      document_sandbox=authored.get('sandbox');
      initial_name=window_name=iframe_element.name;opaque_origin=false;
      if(!lifecycle_ready)return;
      if(authored.get('srcdoc')!==null){fetch_src('about:srcdoc',null,{srcdoc:true}).catch(console.error);return;}
      if(initial_javascript)return;
      if(blank_url()){
        ensure_blank(native_frame_window(iframe_element));
        if(javascript_source())pending_javascript={url:javascript_source(),initial:true};
        queue_javascript();return;
      }
      let remote=false;try{remote=relayed_source(authored_src);}catch{}
      if(remote)fetch_src(authored_src).catch(console.error);
    }
  });
  lifecycle_ready=true;
  if(initial_javascript)return;
  if(blank_url()){if(iframe_element.isConnected)ensure_blank(native_frame_window(iframe_element));queue_javascript();return;}
  if(authored.get('srcdoc')!==null){fetch_src('about:srcdoc',null,{srcdoc:true}).catch(console.error);return;}
  if (!iframe_src) {
    return;
  }
  iframe_element.src = authored_src;
}
import {listen_runtime} from '../runtime_events.mjs';
