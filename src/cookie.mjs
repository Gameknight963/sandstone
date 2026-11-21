import {Cookie,canonicalDomain,defaultPath} from 'tough-cookie';

function fixed_expiry(cookie,now){
  if(cookie.maxAge==null)return cookie;
  const age=Number(cookie.maxAge);if(Number.isNaN(age))return cookie;
  // tough-cookie bases Max-Age on lastAccessed, which its read APIs update.
  // Store one absolute deadline instead, including when a write is replayed.
  cookie.expires=new Date(age<=0?0:Math.min(8640000000000000,now+age*1000));
  cookie.maxAge=null;return cookie;
}

export function cookie_snapshot(snapshot){
  if(!Array.isArray(snapshot?.cookies))return snapshot;
  return {...snapshot,cookies:snapshot.cookies.map(value=>{
    if(value?.maxAge==null)return value;
    const cookie=Cookie.fromJSON(value);if(!cookie)return value;
    const reference=cookie.lastAccessed||cookie.creation,now=reference instanceof Date?reference.getTime():Date.now();
    return fixed_expiry(cookie,Number.isFinite(now)?now:Date.now()).toJSON();
  })};
}

export function set_cookie(jar,cookie,input,options={}){
  const url=new URL(input),domain=canonicalDomain(cookie.domain||url.hostname);
  const path=typeof cookie.path==='string'&&cookie.path.startsWith('/')?cookie.path:defaultPath(url.pathname);
  const now=options.now?.getTime()??Date.now();
  // The jar's synchronous setter otherwise treats an expired value as live:
  // it retains its creation time and can reject replacement of HttpOnly data.
  jar.store.findCookie(domain,path,cookie.key,(error,previous)=>{
    if(!error&&previous&&previous.expiryTime()<=now)jar.store.removeCookie(domain,path,cookie.key,()=>{});
  });
  return jar.setCookieSync(cookie,input,options);
}

export function storage_cookie(value,{crossSite=false,topLevel=false,now=Date.now()}={}) {
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
  return fixed_expiry(cookie,now);
}
