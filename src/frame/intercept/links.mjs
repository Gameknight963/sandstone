import {ctx,convert_url,run_script_safe} from '../context.mjs';
import * as loader from '../loader.mjs';
import {document_referrer_policy} from './document.mjs';
import {download,capture_download} from '../downloads.mjs';
import {install_link_events} from '../link_events.mjs';
import {install_hyperlinks} from '../hyperlinks.mjs';
import {install_html_urls} from '../html_urls.mjs';
import {navigate_target,navigation_target} from '../navigation_targets.mjs';
import {submit} from '../rewrite/form.mjs';
const get_attribute=globalThis.Element?.prototype.getAttribute;

function prepare_activation(element){
  const hint=get_attribute.call(element,'download');if(hint===null)return;
  const value=get_attribute.call(element,'href');if(value===null)return;
  let href;try{href=convert_url(value,ctx.document.baseURI,loader.character_encoding);}catch{return;}
  if(!/^(blob|data):/.test(href))return;
  const activate=capture_download(href,hint);return()=>activate().catch(console.error);
}

function activate(element) {
  if(!element.hasAttribute('href'))return;
  let href;
  try{href=convert_url(element.getAttribute('href'),ctx.document.baseURI,loader.character_encoding);}catch{return;}
  const target=new URL(href),current=new URL(ctx.location.href);
  if(target.protocol==='javascript:'){run_script_safe(href.slice('javascript:'.length));return;}
  const policy=element.relList?.contains('noreferrer')?'no-referrer':element.referrerPolicy||document_referrer_policy();
  if(element.hasAttribute('download')&&(target.origin===current.origin||['data:','blob:'].includes(target.protocol))){
    // Native download-attribute requests use referrerPolicy; rel=noreferrer
    // applies to following hyperlinks through the normal navigation path.
    download(href,element.getAttribute('download'),{referrerPolicy:element.referrerPolicy||document_referrer_policy(),referrer:ctx.location.href}).catch(console.error);
  }else navigate_target(href,navigation_target(element),null,{referrerPolicy:policy}).catch(console.error);
}

if(globalThis.document){
  install_html_urls(()=>ctx.document.baseURI,()=>ctx.location.href);
  install_hyperlinks(()=>ctx.document.baseURI);
  install_link_events({enabled:()=>loader.is_loaded,activate,submit,prepareActivation:prepare_activation});
}
