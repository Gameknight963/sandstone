const realm=globalThis,apply=Reflect.apply;
let clone=realm.structuredClone;

// Crypto decoding is installed after the bundle initializes. Retain that
// configured implementation without consulting an authored global later.
export function configure_clone(implementation){clone=implementation;}
export function clone_value(){return apply(clone,realm,arguments);}
