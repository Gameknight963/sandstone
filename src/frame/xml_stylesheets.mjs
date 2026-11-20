import * as network from './network.mjs';
import * as loader from './loader.mjs';
import {ctx,convert_url} from './context.mjs';
import {parse_css} from './rewrite/css.mjs';
import {document_referrer_policy} from './intercept/document.mjs';
import {parse_referrer_policy} from '../referrer.mjs';
import {decode_stylesheet_response} from '../text_encoding.mjs';
import {track_style_request} from './style_requests.mjs';
import {document_states} from './document_identity.mjs';
import {internal_character_data_mutation,authored_character_data_mutation} from './intercept/mutation_observer.mjs';

const P=globalThis.ProcessingInstruction?.prototype,C=globalThis.CharacterData?.prototype,N=globalThis.Node?.prototype;
const target=P&&Object.getOwnPropertyDescriptor(P,'target').get;
const data=C&&Object.getOwnPropertyDescriptor(C,'data'),length=C&&Object.getOwnPropertyDescriptor(C,'length');
const owner=N&&Object.getOwnPropertyDescriptor(N,'ownerDocument').get;
const kind=N&&Object.getOwnPropertyDescriptor(N,'nodeType').get;
const create=globalThis.Document?.prototype.createProcessingInstruction;
const parse=globalThis.DOMParser?.prototype.parseFromString;
const states=document_states('xml-stylesheets');
let sequence=0;
export function is_xml_stylesheet(node){if(!target)return false;try{return kind.call(node)===7&&target.call(node)==='xml-stylesheet';}catch{return false;}}
const escape=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
function attributes(source){
  const document=parse.call(new DOMParser(),'<instruction '+source+'/>','application/xml');
  const root=document.documentElement;
  return root.localName==='instruction'?[...root.attributes].map(attribute=>[attribute.name,attribute.value]):[];
}
function local_data(source,href){
  const values=attributes(source).filter(([name])=>name!=='href');
  if(href!==null)values.push(['href',href]);
  return values.map(([name,value])=>name+'="'+escape(value)+'"').join(' ');
}
function clear(state){
  state.controller?.abort();state.controller=undefined;
  for(const url of state.urls||[]){delete network.known_urls[url];delete network.stylesheet_contexts[url];}
  state.urls=[];state.url=undefined;
}
function css_url(css,base,context,state){
  const url='data:text/css;charset=utf-8,'+encodeURIComponent(css)+'#sandstone-'+(++sequence);
  const {signal,...stored}=context||{};
  network.known_urls[url]=base;network.stylesheet_contexts[url]=stored;
  (state.urls??=[]).push(url);return url;
}
function render(node,state,value){
  internal_character_data_mutation(node,()=>data.set.call(node,value));
  state.rendered=value;
}
function state_for(node){
  let state=states.get(node);
  if(!state){state={source:data.get.call(node),rendered:null};states.set(node,state);}
  return state;
}
function request(node,state){
  if(state.pending)return state.pending;
  const values=new Map(attributes(state.source)),href=values.get('href'),type=values.get('type');
  // Suppress native XSLT/unknown stylesheet transports as well as remote CSS.
  // A failed/unsupported stylesheet must leave the XML document usable.
  if(!href||type&&type!=='text/css')return;
  // A fragment can name arbitrary XML text containing unrewritten CSS/XSLT.
  // Do not let native fragment resolution start another resource transport.
  if(href.startsWith('#'))return;
  let url;try{url=convert_url(href,ctx.document.baseURI,loader.character_encoding);}catch{return;}
  const controller=state.controller=new AbortController(),source=state.source;
  const pending=(async()=>{
    const inherited=document_referrer_policy(),encoding=loader.character_encoding;
    const response=await network.fetch(url,{destination:'style',mode:'no-cors',credentials:'include',referrerPolicy:inherited,signal:controller.signal});
    if(!response.ok)return;
    const decoded=await decode_stylesheet_response(response,encoding),base=response.url||url;
    const policy=response.headers.get('referrer-policy');
    const context={referrer:base,referrerPolicy:parse_referrer_policy(policy),importPolicy:parse_referrer_policy(policy,inherited),encoding:decoded.encoding};
    const css=await parse_css(decoded.text,base,undefined,{...context,signal:controller.signal},{createURL:async(blob,base,request)=>{
      if(controller.signal.aborted)return 'data:text/css,';
      if(!blob.type.startsWith('text/css'))return network.create_blob_url(blob,base,request);
      const text=await blob.text();return controller.signal.aborted?'data:text/css,':css_url(text,base,request,state);
    }});
    if(controller.signal.aborted||state.source!==source)return;
    // Native PI stylesheets parse data URLs synchronously, preserving parser
    // script blocking without relying on load events that PIs do not dispatch.
    const local=css_url(css,base,context,state);state.url=local;
    render(node,state,local_data(source,local));
  })().catch(()=>{});
  state.pending=pending;track_style_request(node,pending);
  pending.finally(()=>{if(state.pending===pending)state.pending=undefined;});
  return pending;
}
export function rewrite_xml_stylesheet(node){
  if(!is_xml_stylesheet(node))return;
  const state=state_for(node);
  if(state.rendered===null)render(node,state,local_data(state.source,null));
  if(!state.url)return request(node,state);
}
export function copy_xml_stylesheet(source,copy){
  const state=states.get(source);if(state)data.set.call(copy,state.source);
}
export function capture_xml_stylesheet(node){const state=states.get(node);return state?copy=>data.set.call(copy,state.source):undefined;}
function surrogate(node,state){const copy=create.call(owner.call(node),'xml-stylesheet','');data.set.call(copy,state.source);return copy;}
function edit(node,state,source){
  const previous=state.source;clear(state);state.pending=undefined;state.source=source;
  state.rendered=local_data(source,null);
  authored_character_data_mutation(node,previous,()=>data.set.call(node,state.rendered));
  if(owner.call(node)?.defaultView)request(node,state);
}
if(P){
  for(const [prototype,key] of [[C,'data'],[N,'nodeValue'],[N,'textContent']]){
    const property=Object.getOwnPropertyDescriptor(prototype,key);
    Object.defineProperty(prototype,key,{...property,get(){
      const value=property.get.call(this);return states.get(this)?.source??value;
    },set(value){
      if(!is_xml_stylesheet(this))return property.set.call(this,value);
      const state=state_for(this),copy=surrogate(this,state);
      property.set.call(copy,value);edit(this,state,data.get.call(copy));
    }});
  }
  Object.defineProperty(C,'length',{...length,get(){const result=length.get.call(this);return states.get(this)?.source.length??result;}});
  for(const name of ['substringData','appendData','insertData','deleteData','replaceData']){
    const method=C[name];C[name]=new Proxy(method,{apply(target,receiver,args){
      if(!is_xml_stylesheet(receiver))return Reflect.apply(target,receiver,args);
      const state=state_for(receiver),copy=surrogate(receiver,state),result=Reflect.apply(target,copy,args);
      if(name!=='substringData')edit(receiver,state,data.get.call(copy));return result;
    }});
  }
}
