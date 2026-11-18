// Runtime listeners need physical targets, even when they run after a page
// listener. Share only scope records with native-accessible document peers.
const local=new WeakMap(),registries=new Set([local]);
let active=local;
export function configure_event_scope(registry){active=registry;registries.add(registry);}
function state(event){
  for(const registry of registries)if(registry.has(event))return registry.get(event);
  const value={authored:false,view:undefined};active.set(event,value);return value;
}
export function mark_authored_event(event,alias){
  const value=state(event);value.authored=true;
  if(alias)(value.aliases??=new WeakMap()).set(alias.target,alias.alias);
}
export function event_target_alias(event,target){
  for(const registry of registries)if(registry.has(event)){
    const value=registry.get(event);
    return value.override?.target===target?value.override.alias:value.aliases?.get(target);
  }
}
export function authored_event_view(event){
  for(const registry of registries)if(registry.has(event)){const value=registry.get(event);return value.view??value.authored;}
  return false;
}
export function with_event_scope(event,authored,operation,alias){
  if(!event||!['object','function'].includes(typeof event))return operation();
  const value=state(event),previous=value.view,previousAlias=value.override;
  if(authored)value.authored=true;
  value.view=authored;
  if(alias){value.override=alias;(value.aliases??=new WeakMap()).set(alias.target,alias.alias);}
  try{return operation();}finally{value.view=previous;value.override=previousAlias;}
}
