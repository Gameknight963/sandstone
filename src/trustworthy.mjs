// HTTP(S) origins accepted as potentially trustworthy by the relay's browser
// metadata and origin-scoped APIs. URL parsing canonicalizes IP spellings.
export function trustworthy_url(url){
  if(url.protocol==='https:')return true;
  if(url.protocol!=='http:')return false;
  const host=url.hostname.replace(/\.$/,'');
  return host==='[::1]'||/^127(?:\.\d{1,3}){3}$/.test(host)||host==='localhost'||host.endsWith('.localhost');
}
