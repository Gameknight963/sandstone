export const bootstrap_attribute='data-sandstone-bootstrap';
export const bootstrap_global='__sandstone_bootstrap__';
const runtime_types=Object.freeze(['text/html','image/svg+xml','application/xhtml+xml','application/xml','text/xml']);
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
export function runtime_seed(nonce){
  // This runs in a new realm. Keep it as source text so bundling cannot rename
  // its globals into references to the parent runtime's private bindings.
  return 'data:text/html;charset=utf-8,'+seed_encoder.encode('<!doctype html><script data-sandstone-seed="'+nonce+'">('+seed_source+')('+JSON.stringify(nonce)+','+JSON.stringify(runtime_types)+');<\/script>');
}
