import {xml_document_types} from './mime.mjs';
export const bootstrap_attribute='data-sandstone-bootstrap';
export const bootstrap_global='__sandstone_bootstrap__';
const runtime_types=Object.freeze(['text/html',...xml_document_types]);
export function runtime_content_type(type='text/html'){
  if(!runtime_types.includes(type))throw new TypeError('Unsupported runtime document type');
  return type;
}
const native_crypto=globalThis.crypto;
export const seed_encoder={encode:encodeURIComponent};
export function create_bootstrap_nonce(crypto=native_crypto){
  const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);
  return Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
}
export function bootstrap_html(html,nonce,channels=1){
  const value=encodeURIComponent(JSON.stringify({nonce,channels}));
  return html.replace(/<script\b([^>]*)>/i,(_,attributes)=>'<script'+attributes.replace(/\sdata-sandstone-bootstrap\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,'')+' '+bootstrap_attribute+'="'+value+'">');
}
export function bootstrap_worker(source,nonce){return 'globalThis.'+bootstrap_global+'='+JSON.stringify({nonce,channels:1})+';\n'+source;}
export function bootstrap_xml(source,type,nonce,channels=1){
  if(runtime_content_type(type)==='text/html')throw new TypeError('An XML runtime document type is required');
  const script='<script><![CDATA['+source.replaceAll(']]>',']]]]><![CDATA[>')+']]></script>';
  const root=type==='image/svg+xml'?'<svg xmlns="http://www.w3.org/2000/svg">'+script+'</svg>':'<html xmlns="http://www.w3.org/1999/xhtml"><head>'+script+'</head><body></body></html>';
  return bootstrap_html('<?xml version="1.0" encoding="UTF-8"?>'+root,nonce,channels);
}

// Keep opaque document URLs small. The authenticated seed receives the bundle
// after navigation, rather than copying the entire bundle into session history
// and every browser protocol URL/stack trace.
const seed_source=String.raw`function(nonce,types){
    let prepared;
    const receive=event=>{
      const message=event.data;
      if(!event.isTrusted||event.source!==parent||message?.sandstone_bootstrap!==1)return;
      if(!['ping','runtime','commit_runtime'].includes(message.type))return;
      event.stopImmediatePropagation();
      for(const port of event.ports||[])port.close();
      if(message.type==='ping'){
        if(message.url===undefined||message.url===location.href)event.source.postMessage({sandstone_bootstrap:1,type:'pong',id:message.id,url:location.href,nonce},'*');
      }else if(message.type==='runtime'&&!prepared&&message.nonce===nonce&&typeof message.html==='string'){
        const type=message.mime===undefined?'text/html':message.mime;
        if(!types.includes(type))return;
        // Create the blob in this isolated origin, not in the file/HTTP host.
        // Wait for the parent to accept the URL before beginning navigation.
        const url=URL.createObjectURL(new Blob([message.html],{type}));
        prepared=url;
        event.source.postMessage({sandstone_bootstrap:1,type:'runtime_url',id:message.id,nonce,url},'*');
      }else if(message.type==='commit_runtime'&&message.nonce===nonce&&message.url===prepared&&prepared){
        removeEventListener('message',receive,true);location.replace(prepared);
      }
    };
    addEventListener('message',receive,true);
  }`;
// Child runtimes keep the seed's document and navigation-time sandbox flags.
// No second navigation can pick up permissions changed during installation.
const in_place_seed_source=String.raw`function(nonce,mime){
    let prepared;
    const receive=event=>{
      const message=event.data;
      if(!event.isTrusted||event.source!==parent||message?.sandstone_bootstrap!==1)return;
      if(!['ping','runtime','commit_runtime'].includes(message.type))return;
      event.stopImmediatePropagation();
      for(const port of event.ports||[])port.close();
      if(message.type==='ping'){
        if(message.url===undefined||message.url===location.href)event.source.postMessage({sandstone_bootstrap:1,type:'pong',id:message.id,url:location.href,nonce},'*');
      }else if(message.type==='runtime'&&!prepared&&message.nonce===nonce&&typeof message.html==='string'&&(message.mime===undefined?'text/html':message.mime)===mime){
        prepared={html:message.html,url:location.href};
        event.source.postMessage({sandstone_bootstrap:1,type:'runtime_url',id:message.id,nonce,url:prepared.url},'*');
      }else if(message.type==='commit_runtime'&&message.nonce===nonce&&prepared&&message.url===prepared.url){
        removeEventListener('message',receive,true);
        // document.open() would cancel a newer, pending navigation. Populate
        // this document without changing its navigation or parser lifecycle.
        const parsed=new DOMParser().parseFromString(prepared.html,mime==='text/html'?'text/html':'application/xml');
        document.replaceChild(document.importNode(parsed.documentElement,true),document.documentElement);
        const old=document.querySelector('script'),script=document.createElementNS(old.namespaceURI,'script');
        for(const attribute of old.attributes)script.setAttributeNS(attribute.namespaceURI,attribute.name,attribute.value);
        script.textContent=old.textContent;old.replaceWith(script);
      }
    };
    addEventListener('message',receive,true);
  }`;
export function runtime_seed(nonce,{in_place=false,mime='text/html'}={}){
  // This runs in a new realm. Keep it as source text so bundling cannot rename
  // its globals into references to the parent runtime's private bindings.
  mime=runtime_content_type(mime);
  const source=in_place?'('+in_place_seed_source+')('+JSON.stringify(nonce)+','+JSON.stringify(mime)+');':'('+seed_source+')('+JSON.stringify(nonce)+','+JSON.stringify(runtime_types)+');';
  const markup=mime==='text/html'?'<!doctype html><script data-sandstone-seed="'+nonce+'">'+source+'<\/script>':bootstrap_xml(source,mime,nonce);
  return 'data:'+mime+';charset=utf-8,'+seed_encoder.encode(markup);
}
