import {ctx,convert_url,run_script_safe} from '../context.mjs';
import * as loader from '../loader.mjs';
import {document_referrer_policy} from './document.mjs';
import {download} from '../downloads.mjs';

function click(event) {
  if(!loader.is_loaded||event.defaultPrevented)return;
  const element=event.composedPath().find(node=>node instanceof Element&&Element.prototype.matches.call(node,'a[href], area[href]'));
  if(!element)return;
  event.preventDefault();event.stopImmediatePropagation();
  let href;
  try{href=convert_url(element.getAttribute('href'),ctx.document.baseURI);}catch{return;}
  const target=new URL(href),current=new URL(ctx.location.href);
  if(target.protocol==='javascript:'){run_script_safe(href.slice('javascript:'.length));return;}
  const policy=element.relList?.contains('noreferrer')?'no-referrer':element.referrerPolicy||document_referrer_policy();
  if(element.hasAttribute('download')&&(target.origin===current.origin||['data:','blob:'].includes(target.protocol))){
    // Native download-attribute requests use referrerPolicy; rel=noreferrer
    // applies to following hyperlinks through the normal navigation path.
    download(href,element.getAttribute('download'),{referrerPolicy:element.referrerPolicy||document_referrer_policy(),referrer:ctx.location.href}).catch(console.error);
  }else if(target.origin===current.origin&&target.pathname===current.pathname&&target.search===current.search&&(target.hash!==current.hash||target.hash))ctx.location.assign(href);
  else loader.navigate(loader.frame_id,href,true,null,{referrerPolicy:policy}).catch(console.error);
}

if(globalThis.document){
  document.addEventListener('click',click);
  const original=HTMLElement.prototype.click;
  HTMLElement.prototype.click=new Proxy(original,{apply(target,receiver,args){
    // FileSaver-style exports commonly click an anchor without inserting it.
    // Its native click never bubbles to document, so handle the same event on
    // the detached anchor after its existing cancellation handlers have run.
    if((receiver instanceof HTMLAnchorElement||receiver instanceof HTMLAreaElement)&&!receiver.isConnected)receiver.addEventListener('click',click,{once:true});
    return Reflect.apply(target,receiver,args);
  }});
}
