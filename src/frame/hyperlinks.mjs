// Let the browser implement HTMLHyperlinkElementUtils against a virtual base.
// An inert document gives native parsing/setter semantics without navigating.
import {encoding_parse_url} from '../url_encoding.mjs';
import {get_document_encoding} from './document_encoding.mjs';

export function install_hyperlinks(base) {
  const get=Element.prototype.getAttribute,set=Element.prototype.setAttribute,remove=Element.prototype.removeAttribute;
  const owner=Object.getOwnPropertyDescriptor(Node.prototype,'ownerDocument').get;
  const Observer=MutationObserver;
  const mirrors=new Map();
  function mirror(element,tag){
    let entry=mirrors.get(tag);
    if(!entry){
      const doc=document.implementation.createHTMLDocument(''),baseElement=doc.createElement('base');
      doc.head.appendChild(baseElement);
      entry={base:baseElement,link:doc.createElement(tag),observer:new Observer(()=>{})};mirrors.set(tag,entry);
    }
    const baseURL=base();set.call(entry.base,'href',baseURL);
    const href=get.call(element,'href');
    let parsed=href;
    if(href!==null)try{parsed=encoding_parse_url(href,baseURL,get_document_encoding(owner.call(element))).href;}catch{}
    if(href===null)remove.call(entry.link,'href');else set.call(entry.link,'href',parsed);
    return entry;
  }
  for(const [tag,Constructor] of [['a',HTMLAnchorElement],['area',HTMLAreaElement]]){
    const prototype=Constructor.prototype;
    for(const key of ['href','origin','protocol','username','password','host','hostname','port','pathname','search','hash']){
      const descriptor=Object.getOwnPropertyDescriptor(prototype,key);
      if(!descriptor?.get)continue;
      Object.defineProperty(prototype,key,{...descriptor,
        get(){
          const native=descriptor.get.call(this); // Retain native receiver checks.
          return owner.call(this)===document?descriptor.get.call(mirror(this,tag).link):native;
        },
        ...(descriptor.set?{set(value){
          descriptor.get.call(this);
          if(key==='href'||owner.call(this)!==document)return descriptor.set.call(this,value);
          // Web IDL converts the value before parsing the current URL. That
          // conversion can itself mutate this link or read another link.
          const text=`${value}`,entry=mirror(this,tag);
          entry.observer.observe(entry.link,{attributes:true,attributeFilter:['href']});
          let changed;
          try{descriptor.set.call(entry.link,text);changed=entry.observer.takeRecords().length>0;}
          finally{entry.observer.disconnect();}
          const after=get.call(entry.link,'href');
          if(changed){if(after===null)remove.call(this,'href');else set.call(this,'href',after);}
        }}:{})
      });
    }
    const stringifier=Object.getOwnPropertyDescriptor(prototype,'toString');
    if(stringifier?.value)Object.defineProperty(prototype,'toString',{...stringifier,value:new Proxy(stringifier.value,{apply(target,receiver,args){
      const native=Reflect.apply(target,receiver,args);
      return owner.call(receiver)===document?Reflect.apply(target,mirror(receiver,tag).link,args):native;
    }})});
  }
}
