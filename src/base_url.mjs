export function resolve_base_href(href,fallback,previous=fallback) {
  if(href===null||href===undefined)return fallback;
  try{
    const url=new URL(href,fallback);
    return ['data:','javascript:'].includes(url.protocol)?fallback:url.href;
  }catch{return previous;}
}
