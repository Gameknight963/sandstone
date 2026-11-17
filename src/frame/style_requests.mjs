const pending=new WeakMap();
export function track_style_request(element,promise){
  pending.set(element,promise);
  const clear=()=>{if(pending.get(element)===promise)pending.delete(element);};
  promise.then(clear,clear);
}
export const pending_style_request=element=>pending.get(element);
