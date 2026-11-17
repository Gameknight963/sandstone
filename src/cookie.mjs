import {Cookie} from 'tough-cookie';

export function storage_cookie(value,{crossSite=false,topLevel=false}={}) {
  const cookie=Cookie.parse(String(value));
  if(!cookie||cookie.sameSite==='none'&&!cookie.secure)return undefined;
  // Cross-site subresources and nested navigations cannot create or overwrite
  // Default, Lax or Strict cookies. Top-level navigations may set them.
  if(crossSite&&!topLevel&&cookie.sameSite!=='none')return undefined;
  return cookie;
}
