const kinds=['cookies','localStorage','indexedDB','cacheStorage','serviceWorkers','fileSystems'];
function data_url(context){
  const value=context.cookie_url||context.url;
  try{
    if(new URL(value).protocol==='blob:'){
      const origin=context.origin||new URL(context.url).origin;
      if(origin!=='null')return origin+'/';
    }
  }catch{}
  return value;
}
function selected(hostname,selection,url){
  let host;try{host=new URL(url).hostname;}catch{return [];}
  return kinds.filter(kind=>selection[kind]&&(host===hostname||kind==='cookies'&&host.endsWith('.'+hostname)));
}
// Revoke only the old documents of the view being discarded. Their unload
// messages may arrive after deletion; replacement documents have fresh tokens.
export function prepare_site_data_clear(hostname,selection,root,frames,contexts){
  let affected=false;
  for(const entry of contexts.values()){
    const frame=frames[entry.frame];if((entry.context.root_id||frame?.root_id)!==root)continue;
    const cleared=selected(hostname,selection,data_url(entry.context));if(!cleared.length)continue;
    entry.cleared_storage??={};for(const kind of cleared)entry.cleared_storage[kind]=true;
    if(entry.storage&&entry.cleared_storage.localStorage)entry.storage.cleared_local=true;
    if(frame&&!entry.retired)affected=true;
  }
  // A frame may still be fetching its first document and have no context yet.
  return affected||Object.values(frames).some(frame=>frame.root_id===root&&selected(hostname,selection,data_url(frame)).length>0);
}
