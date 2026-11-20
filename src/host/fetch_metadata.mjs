import {getPublicSuffix} from 'tough-cookie';
import {trustworthy_url as metadata_url} from '../trustworthy.mjs';
export {metadata_url};

export function same_site(a,b){
  const domain=hostname=>getPublicSuffix(hostname,{ignoreError:true})||hostname;
  return a.protocol===b.protocol&&domain(a.hostname)===domain(b.hostname);
}

const destinations=new Set(['audio','audioworklet','document','embed','font','frame','iframe','image','json','manifest','object','paintworklet','report','script','serviceworker','sharedworker','style','track','video','webidentity','worker','xslt']);
const modes=new Set(['cors','navigate','no-cors','same-origin','websocket']);

// Redirects retain the least same-site relationship encountered in the URL
// list. Cookie ancestor restrictions do not change the request's own origin.
export function metadata_site(site,source,target,opaque=false){
  if(site==='none'||site==='cross-site')return site;
  if(opaque||source.origin==='null'||!same_site(source,target))return 'cross-site';
  return site==='same-site'||source.origin!==target.origin?'same-site':'same-origin';
}

export function set_fetch_metadata(headers,url,{mode='no-cors',destination,site='cross-site',user=false,nested=false}={}){
  for(const name of [...headers.keys()])if(name.startsWith('sec-fetch-'))headers.delete(name);
  if(!metadata_url(url))return;
  mode=modes.has(mode)?mode:'no-cors';
  destination=mode==='navigate'?(destination===''?'empty':nested?'iframe':'document'):destinations.has(destination)?destination:'empty';
  headers.set('Sec-Fetch-Dest',destination);
  headers.set('Sec-Fetch-Mode',mode);
  headers.set('Sec-Fetch-Site',site);
  if(mode==='navigate'&&user)headers.set('Sec-Fetch-User','?1');
}
