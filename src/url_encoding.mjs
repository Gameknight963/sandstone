import {labelToName} from '@exodus/bytes/encoding.js';
import {percentEncodeAfterEncoding} from '@exodus/bytes/whatwg.js';

// Browser HTML URL reflection uses the document encoding for hierarchical
// queries. Keep native parsing for the host, path, fragment, base and validation.
export function encoding_parse_url(input,base,encoding='UTF-8'){
  const text=`${input}`,url=new URL(text,base),name=labelToName(encoding);
  if(!name||name==='UTF-8'||name==='replacement'||name.startsWith('UTF-16')||!url.href.slice(url.protocol.length).startsWith('/'))return url;
  const cleaned=text.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g,'').replace(/[\t\n\r]/g,'');
  const query=/\?([^#]*)(?:#|$)/.exec(cleaned.split('#',1)[0]);
  const special=['http:','https:','ftp:','file:','ws:','wss:'].includes(url.protocol);
  if(query)url.search='?'+percentEncodeAfterEncoding(name,query[1],special?" \"#'<>":' "#<>');
  return url;
}
