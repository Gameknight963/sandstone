// A rewritten Blob URL may contain a physical opaque origin. Accept its
// virtual origin only when a retained creator context already owns that URL.
export function opened_document_urls(snapshot,origin,contexts){
  const url=new URL(snapshot.url),cookie=new URL(snapshot.cookie_url||snapshot.url);
  const source=contexts.get(snapshot.source_context)?.context;
  const creator=source&&(source.broadcast_origin||new URL(source.url).origin);
  const known_blob=value=>value.protocol==='blob:'&&origin!=='null'&&source&&creator===origin&&
    [source.url,source.cookie_url,source.referrer_url].some(url=>url?.split('#')[0]===value.href.split('#')[0]);
  const matches=value=>value.origin===origin||known_blob(value);
  const inherited=url.protocol==='about:'&&['blank','srcdoc'].includes(url.pathname)&&!url.search;
  if((!matches(url)&&!inherited)||!matches(cookie))throw new DOMException('Document URL must retain its origin','SecurityError');
  const blob=url.protocol==='blob:';
  return {url,cookie_url:inherited?cookie.href:blob?url.href:undefined,inherited_url:inherited?cookie.href:undefined,
    referrer_url:url.protocol==='about:'&&url.pathname==='blank'?'about:blank':blob?url.href:undefined};
}

export function document_request_url(frame){
  const url=new URL(frame.request_url||frame.url);
  return url.origin==='null'&&frame.origin&&frame.origin!=='null'?frame.origin+'/':url.href;
}
