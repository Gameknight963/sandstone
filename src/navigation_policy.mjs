export function sandbox_tokens(value){return new Set((value||'').toLowerCase().split(/[\t\n\f\r ]+/));}
export function navigation_sandbox(parent={},value=null){
  const tokens=sandbox_tokens(value),sandboxed=value!==null;
  return {
    origin:!!parent.origin||sandboxed&&!tokens.has('allow-same-origin'),
    navigation:!!parent.navigation||sandboxed,
    topWithActivation:!!parent.topWithActivation||sandboxed&&!tokens.has('allow-top-navigation')&&!tokens.has('allow-top-navigation-by-user-activation'),
    topWithoutActivation:!!parent.topWithoutActivation||sandboxed&&!tokens.has('allow-top-navigation'),
    topExplicit:!!parent.topExplicit||sandboxed&&tokens.has('allow-top-navigation')
  };
}
function origin(frame){return frame.broadcast_origin||frame.origin||frame.url?.origin||'opaque:'+frame.id;}
function ancestors(frame,frames){
  const output=[],seen=new Set();
  for(let current=frame;current&&!seen.has(current.id);current=frames[current.parent_id]){seen.add(current.id);output.push(current);}
  return output;
}
export function can_navigate(source,target,frames,activation={}){
  if(source.id===target.id)return true;
  const destinationAncestors=ancestors(target,frames),sourceAncestors=ancestors(source,frames),flags=source.navigation_sandbox||{};
  if(destinationAncestors.some(frame=>frame.id===source.id))return true;
  const ancestor=sourceAncestors.some(frame=>frame.id===target.id);
  if(ancestor&&!target.parent_id){
    if(activation.transient?flags.topWithActivation:flags.topWithoutActivation)return false;
  }else if(!ancestor&&flags.navigation)return false;
  if(origin(source)===origin(target))return true;
  if(!target.parent_id)return ancestor&&(!!activation.sticky||!!flags.topExplicit);
  return destinationAncestors.some(frame=>origin(frame)===origin(source));
}
