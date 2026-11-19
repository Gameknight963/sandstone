import {encoding_parse_url} from '../url_encoding.mjs';
import {get_document_encoding} from './document_encoding.mjs';

// Detached elements need virtual reflection before the resource rewriter runs.
export function install_html_urls(base,location){
  const owner=Object.getOwnPropertyDescriptor(Node.prototype,'ownerDocument').get;
  const attribute=Element.prototype.getAttribute;
  for(const [Constructor,key,name,form] of [
    [HTMLScriptElement,'src','src'],[HTMLIFrameElement,'src','src'],[HTMLLinkElement,'href','href'],
    [HTMLFormElement,'action','action',true],[HTMLInputElement,'formAction','formaction',true],[HTMLButtonElement,'formAction','formaction',true]
  ]){
    const property=Object.getOwnPropertyDescriptor(Constructor.prototype,key);
    Object.defineProperty(Constructor.prototype,key,{...property,get:new Proxy(property.get,{apply(target,receiver,args){
      const native=Reflect.apply(target,receiver,args),document=owner.call(receiver);
      if(document!==globalThis.document)return native;
      const value=attribute.call(receiver,name);
      if(form&&!value)return location();
      if(value===null)return native;
      try{return encoding_parse_url(value,base(),get_document_encoding(document)).href;}catch{return native;}
    }})});
  }
}
