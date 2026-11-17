// tough-cookie implements explicit SameSite attributes, but leaves unspecified
// cookies unrestricted. Browsers apply Lax with a short top-level POST grace.
export function cookie_header(jar,url,{sameSiteContext='strict',allowUnsafe=false,now=Date.now()}={}) {
  return jar.getCookiesSync(url).filter(cookie=>{
    if(cookie.sameSite==='none')return cookie.secure;
    if(sameSiteContext==='strict')return true;
    if(cookie.sameSite==='strict')return false;
    if(sameSiteContext==='lax')return true;
    return !cookie.sameSite&&allowUnsafe&&now-cookie.creation.getTime()<=120000;
  }).map(cookie=>cookie.cookieString()).join('; ');
}
