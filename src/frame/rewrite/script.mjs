import * as network from "../network.mjs";
import * as loader from "../loader.mjs";
import { ctx, convert_url, intercept_property, proxy_function } from "../context.mjs";
import { modules, execute_module } from "../polyfill/module.mjs";
import {schedule_resource_event} from '../resource_events.mjs';
import {remember_attribute_order} from '../resource_attributes.mjs';
import {is_svg_script,rewrite_svg_script,capture_svg_script,mark_svg_parser_script,mark_svg_script_connected} from '../svg_scripts.mjs';
import {script_kind} from '../script_types.mjs';
import {defer_script,deferred_script} from '../script_preparation.mjs';
import {ordered_script,ordered_classic} from '../script_schedule.mjs';
import {delay_script_load} from '../script_lifetime.mjs';
import {script_text} from '../script_text.mjs';
import {document_referrer_policy} from '../intercept/document.mjs';
import {parse_referrer_policy} from '../../referrer.mjs';

export const pending_scripts = [];
let script_num = 0;
const records=new WeakMap();
const parser_scripts=new WeakSet();
export function mark_parser_script(element){if(is_svg_script(element))mark_svg_parser_script(element);else if(eligible(element))parser_scripts.add(element);}
const get=globalThis.Element?.prototype.getAttribute,set=globalThis.Element?.prototype.setAttribute,remove=globalThis.Element?.prototype.removeAttribute;
const N=globalThis.Node?.prototype,append=N?.appendChild,remove_child=N?.removeChild,insert=N?.insertBefore;
const owner=N&&Object.getOwnPropertyDescriptor(N,'ownerDocument').get,connected=N&&Object.getOwnPropertyDescriptor(N,'isConnected').get;
const data=N&&Object.getOwnPropertyDescriptor(N,'textContent');
const view=globalThis.Document&&Object.getOwnPropertyDescriptor(Document.prototype,'defaultView').get;
const baseURI=N&&Object.getOwnPropertyDescriptor(N,'baseURI').get;
const src_property=globalThis.HTMLScriptElement&&Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,'src');
const adopt=globalThis.Document?.prototype.adoptNode;
let inert;
function eligible(element,record){
  const kind=script_kind(record?record.type():get.call(element,'type'),get.call(element,'language'));
  return kind!==null&&
    ((record?record.src():get.call(element,'src'))!==null||script_text(element).length>0);
}
export function mark_script_connected(element){
  if(is_svg_script(element)){mark_svg_script_connected(element);return;}
  if(!globalThis.HTMLScriptElement||!(element instanceof HTMLScriptElement)||!connected.call(element))return;
  if(deferred_script(element))return;
  const record=records.get(element);if(!eligible(element,record))return;
  if(record)record.started=true;
  else if(!view.call(owner.call(element))||element.__rewritten__===true)element.__sandstone_inert__=true;
}
export function prime_inert_script(element){
  // Native preparation in a document with scripting disabled sets the real
  // already-started flag. A private document avoids executing authored code.
  inert??=document.implementation.createHTMLDocument('');
  const original=owner.call(element),parent=element.parentNode,next=element.nextSibling,children=[...element.childNodes];
  for(const child of children)remove_child.call(element,child);
  remove.call(element,'src');set.call(element,'type','text/javascript');data.set.call(element,' ');
  adopt.call(inert,element);append.call(inert.body,element);remove_child.call(inert.body,element);
  data.set.call(element,'');for(const child of children)append.call(element,child);
  adopt.call(original,element);if(parent)insert.call(parent,element,next);
}
export function clone_script(source,copy,prime=false,serializing=false){
  capture_script(source)?.(copy,prime,serializing);
}
export function capture_script(source){
  if(is_svg_script(source))return capture_svg_script(source);
  if(!globalThis.HTMLScriptElement||!(source instanceof HTMLScriptElement))return;
  const record=records.get(source),started=parser_scripts.has(source)||source.__sandstone_inert__||record&&(record.started||connected.call(source)&&eligible(source,record));
  const type=record?.type(),src=record?.src();
  return (copy,prime=false,serializing=false)=>{
    if(started)copy.__sandstone_inert__=true;
    if(record){
      if(started&&prime)prime_inert_script(copy);
      const restored=started&&!prime&&!serializing?'application/x-sandstone-script':type;
      if(restored===null)remove.call(copy,'type');else set.call(copy,'type',restored);
      if(src===null)remove.call(copy,'src');else set.call(copy,'src',src);
    }
    Object.defineProperty(copy,'src',{configurable:true,enumerable:src_property.enumerable,
      get(){const native=src_property.get.call(this);if(this!==copy)return native;const value=get.call(copy,'src');if(value===null)return '';
        try{return convert_url(value,owner.call(copy)===document?ctx.document.baseURI:baseURI.call(copy));}catch{return value;}},set:src_property.set
    });
  };
}

export function should_load(element) {
  const kind=script_kind(get.call(element,'type'),get.call(element,'language'));
  return loader.site_settings.allow_js && (kind==='classic'||kind==='module');
}

export function rewrite_script(element,{parser=false,signal,run,sourceElement=element,awakened=false}={}) {
  if(is_svg_script(element))return rewrite_svg_script(element,{parser,signal,run});
  if(deferred_script(element))return;
  remember_attribute_order(element,['src','type']);
  const original_type=get.call(element,'type');
  const kind=script_kind(original_type,get.call(element,'language'));
  if(!awakened&&!element.__sandstone_inert__&&(kind===null||get.call(element,'src')===null&&script_text(element)==='')){
    defer_script(element,()=>rewrite_script(element,{sourceElement,awakened:true}));return;
  }
  if (kind === "importmap") {
    records.set(element,{started:false,type:()=>get.call(element,'type')==='application/x-sandstone-importmap'?original_type:get.call(element,'type'),src:()=>get.call(element,'src')});
    element.type = "application/x-sandstone-importmap";
    if (loader.site_settings.allow_js && !element.__sandstone_inert__) {
      try { modules.map.add(script_text(element), ctx.document.baseURI); }
      catch (error) { element.dispatchEvent(new Event("error")); console.error(error); }
    }
    return;
  }
  const is_module = kind === "module";
  if (kind!=='classic'&&!is_module) return;
  const enabled = loader.site_settings.allow_js && !element.__sandstone_inert__ && (is_module || !element.noModule);
  element.__sandstone_module__ = is_module;
  let script_url = element.getAttribute("src");
  let authored_src=script_url;
  const ordered=!parser&&enabled&&(is_module||script_url!==null)&&element.async===false;
  records.set(element,{started:false,type:()=>get.call(element,'type')==='application/x-sandstone-script'?original_type:get.call(element,'type'),src:()=>authored_src});
  const num = script_num++;
  let text = script_text(element);
  let ready = script_url===null;
  let classic_context;
  let executed = false;
  let started = false;
  let prepared;
  let resource,order,failure,preparation_document,finish_load=()=>{},was_connected=false,order_released=false,load_started=false;
  element.type = "application/x-sandstone-script";
  element.removeAttribute("src");

  element.__sandstone_execute__ = () => {
    if(!was_connected&&element.isConnected){
      was_connected=true;preparation_document=owner.call(sourceElement);
    }
    if (!enabled || executed || !was_connected || (script_url===null && script_text(element)==='')) return;
    if(!parser&&!load_started&&(is_module||script_url!==null)){load_started=true;finish_load=delay_script_load();}
    if(ordered){
      executed=true;order=ordered_script();
      Promise.resolve(is_module?prepared:resource).then(record=>order.ready(()=>{
        order_released=true;
        if(owner.call(sourceElement)!==preparation_document){finish_load();return;}
        if(failure)return ordered_classic(()=>{try{deliver_error(failure);}finally{finish_load();}});
        if(is_module)return record?execute_module(record,{ordered:true}).then(()=>{if(script_url!==null)sourceElement.dispatchEvent(new Event('load'));finish_load();}):undefined;
        return ordered_classic(execute_classic);
      }));
      return order.finished.catch(report_error);
    }
    if(owner.call(sourceElement)!==preparation_document){executed=true;finish_load();return;}
    if (is_module) {
      executed = true;
      prepared ||= prepare_module();
      return prepared.then(async record => {
        if (!record) return;
        await execute_module(record);
        if(script_url!==null)sourceElement.dispatchEvent(new Event("load"));
        finish_load();
      }).catch(report_error);
    }
    if (!ready) return;
    started = true;
    executed = true;
    return execute_classic();
  };

  function execute_classic(){
    try{
      classic_context??=classic_request_context();
      loader.eval_script(sourceElement,script_url!==null?text:script_text(element),{run,context:classic_context});
      if(script_url!==null)sourceElement.dispatchEvent(new Event('load'));
    }finally{finish_load();}
  }

  function report_error(error) {
    if(signal?.aborted)return;
    if(ordered&&!order_released){failure=error;return;}
    if(parser){schedule_resource_event(sourceElement,()=>deliver_error(error));return;}
    const deliver=()=>{
      if(!was_connected){schedule_resource_event(sourceElement,deliver);return;}
      try{if(owner.call(sourceElement)===preparation_document)deliver_error(error);}finally{finish_load();}
    };
    setTimeout(deliver,0);
  }
  function deliver_error(error){
    if(signal?.aborted)return;
    const source=script_url||ctx.location.href;
    console.error(`Script failed: ${source}: ${error.message}`);
    sourceElement.dispatchEvent(new Event("error"));
  }

  async function prepare_module() {
    if (!enabled) return null;
    if(script_url===null&&script_text(element)==='')return null;
    started=true;
    const credentials = element.crossOrigin === "use-credentials" ? "include" : "same-origin";
    const context={referrer:ctx.location.href,referrerPolicy:parse_referrer_policy(element.referrerPolicy,document_referrer_policy())};
    try {
      if(script_url==='')throw new TypeError('Script source is empty');
      return await (script_url ? modules.prepare_url(convert_url(script_url, ctx.document.baseURI), ctx.document.baseURI, {credentials,context}) :
        modules.prepare_inline(script_text(element), ctx.document.baseURI, credentials,context));
    } catch(error) {
      report_error(error);
      return null;
    }
  }

  async function download() {
    if (!enabled || script_url===null || started) return;
    started=true;
    ready = false;
    try {
      if(script_url==='')throw new TypeError('Script source is empty');
      classic_context=classic_request_context();
      const response = await network.fetch(convert_url(script_url, ctx.document.baseURI), {
        mode:classic_context.mode,credentials:classic_context.networkCredentials,
        referrerPolicy:classic_context.referrerPolicy,destination:'script',signal
      });
      if (!response.ok) throw new TypeError(`Script request failed: ${response.status}`);
      text = await response.text();
      element.__sandstone_url__ = response.url || convert_url(script_url, ctx.document.baseURI);
      classic_context.url=element.__sandstone_url__;
      classic_context.muted=classic_context.mode==='no-cors'&&(response.request_cross_origin??response.type==='opaque');
      if(sourceElement!==element)sourceElement.__sandstone_url__=element.__sandstone_url__;
      ready = true;
      if (loader.is_loaded&&!parser) element.__sandstone_execute__();
    } catch (error) {
      report_error(error);
    }
  }

  function classic_request_context(){
    const crossOrigin=element.crossOrigin;
    return {url:script_url===null?ctx.document.baseURI:undefined,credentials:crossOrigin==='use-credentials'?'include':'same-origin',mode:crossOrigin===null?'no-cors':'cors',networkCredentials:crossOrigin==='anonymous'?'same-origin':'include',referrerPolicy:parse_referrer_policy(element.referrerPolicy,document_referrer_policy())};
  }

  intercept_property(element, "src", {
    get: () => {
      if(authored_src===null)return '';
      try{return convert_url(authored_src,ctx.document.baseURI);}
      catch{return authored_src;}
    },
    set: value => {
      authored_src = `${value}`;
      // Native scripts keep the request and execution chosen at preparation,
      // while subsequent src writes still update their reflected attributes.
      if(started)return;
      script_url=authored_src;
      if (is_module) {
        prepared = prepare_module();
        prepared.catch(report_error);
        if (loader.is_loaded) element.__sandstone_execute__();
      } else resource=download();
    }
  });
  for(const name of ['getAttribute','hasAttribute','setAttribute','removeAttribute']){
    proxy_function(element,name,(target,receiver,args)=>{
      const required=name==='setAttribute'?2:1;
      if(receiver!==element||args.length<required)return Reflect.apply(target,receiver,args);
      const attribute=`${args[0]}`;
      if(attribute.toLowerCase()==='src'){
        if(name==='getAttribute')return authored_src;
        if(name==='hasAttribute')return authored_src!==null;
        if(name==='setAttribute'){element.src=args[1];return;}
        authored_src=null;
        if(!started){script_url=null;ready=true;}
      }
      return Reflect.apply(target,receiver,[attribute,...args.slice(1)]);
    });
  }
  if (!loader.is_loaded&&!parser) pending_scripts.push([num, element]);
  if (is_module) {
    prepared = prepare_module();
    return prepared.catch(report_error);
  }
  return script_url!==null ? resource=download() : undefined;
}
