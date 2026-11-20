const kinds=['cookies','localStorage','indexedDB','cacheStorage','serviceWorkers','fileSystems'];
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
    const cleared=selected(hostname,selection,entry.context.cookie_url||entry.context.url);if(!cleared.length)continue;
    entry.cleared_storage??={};for(const kind of cleared)entry.cleared_storage[kind]=true;
    if(entry.storage&&entry.cleared_storage.localStorage)entry.storage.cleared_local=true;
    if(frame&&!entry.retired)affected=true;
  }
  // A frame may still be fetching its first document and have no context yet.
  return affected||Object.values(frames).some(frame=>frame.root_id===root&&selected(hostname,selection,frame.cookie_url||frame.url?.href).length>0);
}
