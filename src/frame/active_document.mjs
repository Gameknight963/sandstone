// An initial javascript: navigation can create a new Document while retaining
// the Window and its native Script environment. Refresh the bundle's private
// document binding without reinstalling prototype interceptors in that realm.
let current=globalThis.document;
const observers=new Set();
export function on_document_change(observer){observers.add(observer);return ()=>observers.delete(observer);}
export function refresh_document(){
  const next=globalThis.document,previous=current;
  if(next===previous)return false;
  const after=[...observers].map(observer=>observer(previous,next));
  document=next;
  current=next;
  for(const callback of after)callback?.();
  return true;
}
