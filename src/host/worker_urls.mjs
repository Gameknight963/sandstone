import {worker_script_url} from './frame_context.mjs';

// Only the trusted host supplies creator_url. A physical blob:null URL does
// not carry the virtual creator's origin, so it cannot establish one itself.
export function worker_urls({url,creator_url=url,top_url=creator_url}={}){
  const creator=new URL(creator_url),top=new URL(top_url);
  if(!['http:','https:'].includes(creator.protocol)||!['http:','https:'].includes(top.protocol))throw new TypeError('HTTP creator and top-level URLs are required');
  const script=worker_script_url(url,creator.origin);
  return {script,creator,top,origin:script.protocol==='data:'?'null':creator.origin};
}
