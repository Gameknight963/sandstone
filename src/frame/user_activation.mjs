// Metadata and navigation permissions must use the browser's activation state,
// even when a page overrides the public Navigator/UserActivation properties.
const apply=Reflect.apply,navigator=globalThis.navigator;
const get=globalThis.Navigator&&Object.getOwnPropertyDescriptor(Navigator.prototype,'userActivation')?.get;
const activation=get&&apply(get,navigator,[]),prototype=activation&&Object.getPrototypeOf(activation);
const active=prototype&&Object.getOwnPropertyDescriptor(prototype,'isActive')?.get;
const sticky=prototype&&Object.getOwnPropertyDescriptor(prototype,'hasBeenActive')?.get;
export function navigation_activation(){
  return {transient:!!(active&&apply(active,activation,[])),sticky:!!(sticky&&apply(sticky,activation,[]))};
}
