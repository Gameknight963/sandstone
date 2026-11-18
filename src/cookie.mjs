import {Cookie} from 'tough-cookie';

export function storage_cookie(value,{crossSite=false,topLevel=false}={}) {
  const text=String(value);let cookie=Cookie.parse(text);
  if(!cookie){
    const semicolon=text.indexOf(';'),pair=text.slice(0,semicolon<0?undefined:semicolon).trim(),equals=pair.indexOf('=');
    if(equals<=0){
      const contents=(equals===0?pair.slice(1):pair).trim();
      if(contents&&!contents.includes('=')&&!/^__(?:Host|Secure)-/.test(contents)){
        cookie=Cookie.parse('sandstone_unnamed='+contents+(semicolon<0?'':text.slice(semicolon)));
        if(cookie)cookie.key='';
      }
    }
  }
  if(!cookie||cookie.sameSite==='none'&&!cookie.secure)return undefined;
  // Cross-site subresources and nested navigations cannot create or overwrite
  // Default, Lax or Strict cookies. Top-level navigations may set them.
  if(crossSite&&!topLevel&&cookie.sameSite!=='none')return undefined;
  return cookie;
}
