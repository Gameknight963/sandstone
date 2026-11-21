import {domainMatch} from 'tough-cookie';
import {iframes} from './frames.mjs';
import {beacons} from './network.mjs';
import {site_data} from './site_data.mjs';
import * as rpc from '../rpc.mjs';
const delivered=new WeakMap();
function document_port(frame){
  const root=iframes[frame.root_id];
  return frame.id===frame.root_id?root?.rpc_target.target:root?.rpc_target.extra_frame_targets.get(frame.id);
}

function snapshot(context){
  const source=context.context;
  return site_data.documentCookies(source.cookie_url||source.url,{crossSite:source.cross_site});
}
rpc.rpc_handlers.cookies_ready=(id,token)=>{
  const frame=iframes[id],context=beacons.contexts.get(token);
  if(!frame||frame.document_context!==token||context?.frame!==id||context.retired)throw new DOMException('Cookie document is unavailable','InvalidStateError');
  if(context.context.broadcast_origin?.startsWith('opaque:'))return undefined;
  const value=snapshot(context),port=document_port(frame);
  if(port)delivered.set(port,{token,revision:value.sandstone_revision});
  return value;
};
site_data.cookieListeners.add(domain=>{
  for(const frame of Object.values(iframes)){
    if(frame.cookie_policy)continue;
    const context=beacons.contexts.get(frame.document_context);
    if(!context||context.retired||context.context.broadcast_origin?.startsWith('opaque:'))continue;
    // Use the frozen document context; frame.url can already name the next
    // destination while its old document is still waiting to be replaced.
    const source=context.context.cookie_url||context.context.url;
    if(domain&&!domainMatch(new URL(source).hostname,domain))continue;
    const port=document_port(frame);if(!port)continue;
    const value=snapshot(context),previous=delivered.get(port);
    if(previous?.token===frame.document_context&&previous.revision===value.sandstone_revision)continue;
    delivered.set(port,{token:frame.document_context,revision:value.sandstone_revision});
    rpc.notify(port,'cookies_update',[frame.document_context,value]);
  }
});
