import * as network from "../network.mjs";
import * as loader from "../loader.mjs";
import { ctx, convert_url, intercept_property, proxy_function } from "../context.mjs";
import { modules, execute_module } from "../polyfill/module.mjs";
import {schedule_resource_event} from '../resource_events.mjs';

export const pending_scripts = [];
let script_num = 0;
const classic_types = new Set(["", "application/javascript", "text/javascript", "application/ecmascript", "text/ecmascript"]);
const records=new WeakMap();
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
  const type=((record?record.type():get.call(element,'type'))||'').trim();
  return (classic_types.has(type.toLowerCase())||type==='module'||type==='importmap')&&
    ((record?record.src():get.call(element,'src'))!==null||data.get.call(element).length>0);
}
export function mark_script_connected(element){
  if(!globalThis.HTMLScriptElement||!(element instanceof HTMLScriptElement)||!connected.call(element))return;
  const record=records.get(element);if(!eligible(element,record))return;
  if(record)record.started=true;
  else if(!view.call(owner.call(element))||element.__rewritten__===true)element.__sandstone_inert__=true;
}
function prime_inert_script(element){
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
export function clone_script(source,copy,prime=false){
  capture_script(source)?.(copy,prime);
}
export function capture_script(source){
  if(!globalThis.HTMLScriptElement||!(source instanceof HTMLScriptElement))return;
  const record=records.get(source),started=source.__sandstone_inert__||record&&(record.started||connected.call(source)&&eligible(source,record));
  const type=record?.type(),src=record?.src();
  return (copy,prime=false)=>{
    if(started)copy.__sandstone_inert__=true;
    if(record){
      if(started&&prime)prime_inert_script(copy);
      const restored=started&&!prime?'application/x-sandstone-script':type;
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
  return loader.site_settings.allow_js && (classic_types.has(element.type.trim().toLowerCase()) || element.type === "module");
}

export function rewrite_script(element) {
  const original_type=get.call(element,'type');
  const type = element.type.trim().toLowerCase();
  if (type === "importmap") {
    records.set(element,{started:false,type:()=>get.call(element,'type')==='application/x-sandstone-importmap'?original_type:get.call(element,'type'),src:()=>get.call(element,'src')});
    element.type = "application/x-sandstone-importmap";
    if (loader.site_settings.allow_js && !element.__sandstone_inert__) {
      try { modules.map.add(element.textContent, ctx.document.baseURI); }
      catch (error) { element.dispatchEvent(new Event("error")); console.error(error); }
    }
    return;
  }
  const is_module = type === "module";
  if (!classic_types.has(type) && !is_module) return;
  const enabled = loader.site_settings.allow_js && !element.__sandstone_inert__ && (is_module || !element.noModule);
  element.__sandstone_module__ = is_module;
  let script_url = element.getAttribute("src");
  let authored_src=script_url;
  records.set(element,{started:false,type:()=>get.call(element,'type')==='application/x-sandstone-script'?original_type:get.call(element,'type'),src:()=>authored_src});
  const num = script_num++;
  let text = element.textContent;
  let ready = script_url===null;
  let executed = false;
  let started = false;
  let prepared;
  element.type = "application/x-sandstone-script";
  element.removeAttribute("src");

  element.__sandstone_execute__ = () => {
    if (!enabled || executed || !element.isConnected || (script_url===null && !element.textContent.trim())) return;
    if (is_module) {
      executed = true;
      prepared ||= prepare_module();
      return prepared.then(async record => {
        if (!record) return;
        await execute_module(record);
        element.dispatchEvent(new Event("load"));
      }).catch(report_error);
    }
    if (!ready) return;
    started = true;
    executed = true;
    loader.eval_script(element, script_url ? text : element.textContent);
  };

  function report_error(error) {
    const source=script_url||ctx.location.href;
    schedule_resource_event(element,()=>{
      console.error(`Script failed: ${source}: ${error.message}`);
      element.dispatchEvent(new Event("error"));
    });
  }

  async function prepare_module() {
    if (!enabled) return null;
    if(script_url===null&&!element.textContent.trim())return null;
    started=true;
    const credentials = element.crossOrigin === "use-credentials" ? "include" : "same-origin";
    try {
      if(script_url==='')throw new TypeError('Script source is empty');
      return await (script_url ? modules.prepare_url(convert_url(script_url, ctx.document.baseURI), ctx.document.baseURI, {credentials}) :
        modules.prepare_inline(element.textContent, ctx.document.baseURI, credentials));
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
      const response = await network.fetch(convert_url(script_url, ctx.document.baseURI), {
        mode:element.crossOrigin === null ? 'no-cors' : 'cors',
        credentials:element.crossOrigin === 'anonymous' ? 'same-origin' : 'include',
        referrerPolicy:element.referrerPolicy
      });
      if (!response.ok) throw new TypeError(`Script request failed: ${response.status}`);
      text = await response.text();
      element.__sandstone_url__ = response.url || convert_url(script_url, ctx.document.baseURI);
      ready = true;
      if (loader.is_loaded) element.__sandstone_execute__();
    } catch (error) {
      report_error(error);
    }
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
      } else download();
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
  if (!loader.is_loaded) pending_scripts.push([num, element]);
  if (is_module) {
    prepared = prepare_module();
    return prepared.catch(report_error);
  }
  return script_url!==null ? download() : undefined;
}
