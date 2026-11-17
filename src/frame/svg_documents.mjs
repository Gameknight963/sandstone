import {rewrite_css} from './css.mjs';
import {rewrite_srcset} from './srcset.mjs';

const svg='http://www.w3.org/2000/svg',xlink='http://www.w3.org/1999/xlink',xml='http://www.w3.org/XML/1998/namespace';
const Parser=globalThis.DOMParser,Serializer=globalThis.XMLSerializer;
const parse=Parser?.prototype.parseFromString,serialize=Serializer?.prototype.serializeToString;
const get=globalThis.Element?.prototype.getAttribute,set=globalThis.Element?.prototype.setAttribute;
const getNS=globalThis.Element?.prototype.getAttributeNS,setNS=globalThis.Element?.prototype.setAttributeNS;
const remove=globalThis.Element?.prototype.removeAttributeNS;
const text=globalThis.Node&&Object.getOwnPropertyDescriptor(Node.prototype,'textContent');
const removeNode=globalThis.Node?.prototype.removeChild;
const query=globalThis.Document?.prototype.querySelectorAll;
const create=globalThis.Document?.prototype.createElementNS,prepend=globalThis.Node?.prototype.insertBefore;
const strip=url=>url.split('#')[0];

// A blob-backed use document can itself load images, symbols and stylesheets.
// Rewrite those dependencies before exposing the document to the native loader.
export async function relay_svg_document(blob,base,{fetch,createURL,signal,referrerPolicy}){
  const cache=new Map();
  const css=(source,base,request)=>rewrite_css(source,base,{fetch,createURL,request,supports:condition=>CSS.supports(condition)||CSS.supports(`(${condition})`)},new Set([base]));
  async function document_blob(blob,base,ancestors){
    const document=parse.call(new Parser(),await blob.text(),'image/svg+xml');
    if(document.documentElement?.namespaceURI!==svg||document.documentElement.localName!=='svg'||query.call(document,'parsererror').length)return new Blob([],{type:blob.type});
    const documentURL=strip(base);
    const request={signal,referrer:base,referrerPolicy,mode:'no-cors',credentials:'include'};
    const first=document.documentElement.firstChild;
    for(const node of [...document.childNodes])if(node.nodeType===7&&node.target==='xml-stylesheet'){
      const attributes=parse.call(new Parser(),'<stylesheet '+node.data+'/>','application/xml').documentElement;
      const href=get.call(attributes,'href'),type=get.call(attributes,'type'),media=get.call(attributes,'media');
      removeNode.call(document,node);
      if(!href||type&&type!=='text/css'||get.call(attributes,'alternate')==='yes')continue;
      try{
        const url=new URL(href,base).href,response=await fetch(url,request);
        if(!response.ok){await response.body?.cancel();continue;}
        const final=response.url||url,style=create.call(document,svg,'style');
        const source=await css(await response.text(),final,{...request,referrer:final});
        text.set.call(style,media?'@media '+media+'{'+source+'}':source);
        prepend.call(document.documentElement,style,first);
      }catch(error){if(signal.aborted)throw error;}
    }
    const source_base=element=>{
      const chain=[];for(let current=element;current?.nodeType===1;current=current.parentNode)chain.unshift(current);
      let result=base;for(const current of chain){const value=getNS.call(current,xml,'base');if(value!==null)try{result=new URL(value,result).href;}catch{}}
      return result;
    };
    const resource=async(source,base,symbol=false)=>{
      if(!source)return source;
      if(source.startsWith('#'))return source;
      let url;try{url=new URL(source,base);}catch{return '';}
      if(symbol&&url.hash&&strip(url.href)===documentURL)return url.hash;
      if(!symbol&&['data:','blob:'].includes(url.protocol))return url.href;
      if(!['http:','https:','data:','blob:'].includes(url.protocol))return '';
      const remote=strip(url.href),key=JSON.stringify([remote,symbol]);
      if(symbol&&ancestors.has(remote))return '';
      if(!cache.has(key))cache.set(key,(async()=>{
        try{
          const response=await fetch(remote,{...request,referrer:base,...(symbol?{mode:'same-origin',credentials:'same-origin'}:{})});
          if(!response.ok){await response.body?.cancel();return '';}
          const final=response.url||remote;
          let bytes=await response.blob();signal.throwIfAborted();
          if(symbol){
            if(ancestors.has(strip(final)))return '';
            bytes=await document_blob(bytes,final,new Set([...ancestors,remote,strip(final)]));
          }
          signal.throwIfAborted();return createURL(bytes,final);
        }catch(error){if(signal.aborted)throw error;return '';}
      })());
      const local=await cache.get(key);return local?local+url.hash:'';
    };
    const elements=[...query.call(document,'*')],bases=new Map(elements.map(element=>[element,source_base(element)]));
    for(const element of elements){
      const base=bases.get(element),tag=element.localName;
      // Resource documents never execute scripts. Do not let blob transport
      // change that rule or fetch an authored script URL.
      if(tag==='script'){removeNode.call(element.parentNode,element);continue;}
      if(element.namespaceURI===svg&&['image','feImage','use'].includes(tag)){
        const modern=get.call(element,'href'),legacy=getNS.call(element,xlink,'href'),source=modern??legacy;
        if(source!==null){
          const local=source.startsWith('#')&&tag!=='use'?source:await resource(source,base,tag==='use');
          if(modern!==null){set.call(element,'href',local);remove.call(element,xlink,'href');}
          else setNS.call(element,xlink,'xlink:href',local);
        }
      }
      if(element.namespaceURI==='http://www.w3.org/1999/xhtml'&&['img','source','video','audio','input','track'].includes(tag)){
        for(const name of ['src','poster','srcset']){
          const source=get.call(element,name);if(source===null)continue;
          set.call(element,name,name==='srcset'?await rewrite_srcset(source,value=>resource(value,base)):await resource(source,base));
        }
      }
      if(element.namespaceURI===svg&&['set','animate'].includes(tag)&&['href','xlink:href'].includes(get.call(element,'attributeName'))){
        const reference=get.call(element,'href')??getNS.call(element,xlink,'href');
        const target=reference?.startsWith('#')?document.getElementById(reference.slice(1)):element.parentNode;
        for(const name of ['to','from','by','values']){
          const source=get.call(element,name);if(source===null)continue;
          const values=name==='values'?source.split(';'):[source],local=[];
          for(const value of values)local.push(await resource(value.trim(),base,target?.localName==='use'));
          set.call(element,name,local.join(';'));
        }
      }
      if(tag==='style')text.set.call(element,await css(text.get.call(element),base,{...request,referrer:base}));
      const inline=get.call(element,'style');if(inline!==null)set.call(element,'style',await css(inline,base,{...request,referrer:base}));
      // Presentation attributes may also contain external CSS resources.
      for(const attribute of [...element.attributes])if(/url\s*\(/i.test(attribute.value))setNS.call(element,attribute.namespaceURI,attribute.name,await css(attribute.value,base,{...request,referrer:base}));
      remove.call(element,xml,'base');
    }
    signal.throwIfAborted();
    return new Blob([serialize.call(new Serializer(),document)],{type:blob.type||'image/svg+xml'});
  }
  return document_blob(blob,base,new Set([strip(base)]));
}
