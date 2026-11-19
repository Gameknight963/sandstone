import {trustworthy_url} from '../trustworthy.mjs';
import {mime_essence} from '../mime.mjs';
import {javascript_mime_essence} from '../frame/script_types.mjs';

const security=message=>new DOMException(message,'SecurityError');
const text=value=>`${value}`;
function worker_url(input,base){
  const url=new URL(input,base);url.hash='';
  if(!['http:','https:'].includes(url.protocol))throw new TypeError('Service worker URLs must use HTTP or HTTPS');
  if(/%2f|%5c/i.test(url.pathname))throw new TypeError('Service worker paths cannot contain escaped separators');
  return url;
}

// Normalize against the virtual client origin rather than the standalone
// host's file/blob origin.
export function normalize_registration(scriptURL,options,{base,origin=new URL(base).origin}){
  const scriptText=text(scriptURL),dictionary=options??{};
  if(!['object','function'].includes(typeof dictionary))throw new TypeError('Registration options must be a dictionary');
  // Web IDL reads dictionary members in this order, before URL parsing.
  const scopeValue=dictionary.scope,scopeText=scopeValue===undefined?undefined:text(scopeValue);
  const typeValue=dictionary.type,type=typeValue===undefined?'classic':text(typeValue);
  if(!['classic','module'].includes(type))throw new TypeError('Invalid service worker type');
  const cacheValue=dictionary.updateViaCache,updateViaCache=cacheValue===undefined?'imports':text(cacheValue);
  if(!['imports','all','none'].includes(updateViaCache))throw new TypeError('Invalid service worker update cache mode');
  const script=worker_url(scriptText,base),scope=worker_url(scopeText===undefined?'./':scopeText,scopeText===undefined?script:base);
  let principal;try{principal=new URL(origin);}catch{throw security('Service worker origin is unavailable');}
  if(principal.origin==='null'||!trustworthy_url(principal)||script.origin!==principal.origin||scope.origin!==principal.origin)throw security('Service worker script and scope must share a trustworthy client origin');
  return {scriptURL:script.href,scope:scope.href,origin:principal.origin,type,updateViaCache};
}

// Run before evaluating the entry script. Redirects are also forbidden in the
// script request itself; this check protects cached/transport response metadata.
export function validate_registration_response(registration,response){
  if(response.redirected)throw security('Service worker entry scripts cannot redirect');
  if(response.status<200||response.status>299)throw new TypeError('Service worker script request failed');
  const script=new URL(registration.scriptURL),scope=new URL(registration.scope);
  if(response.url&&new URL(response.url).origin!==script.origin)throw security('Service worker script response changed origin');
  if(!javascript_mime_essence(mime_essence(response.headers.get('content-type'))))throw security('Service worker script must have a JavaScript MIME type');
  const allowed=response.headers.get('service-worker-allowed');
  let maximum;
  try{maximum=new URL(allowed===null?'./':allowed,script);}catch{throw security('Invalid Service-Worker-Allowed URL');}
  if(maximum.origin!==script.origin||!scope.pathname.startsWith(maximum.pathname))throw security('Service worker scope exceeds the allowed script scope');
}

export function select_registration(registrations,clientURL,origin=new URL(clientURL).origin){
  const client=new URL(clientURL);client.hash='';
  if(client.origin!==origin)throw security('Service worker client lookup must remain same-origin');
  let selected=null,length=-1;
  for(const registration of registrations){
    const scope=new URL(registration.scope);scope.hash='';
    if(scope.origin===origin&&client.href.startsWith(scope.href)&&scope.href.length>length){selected=registration;length=scope.href.length;}
  }
  return selected;
}
