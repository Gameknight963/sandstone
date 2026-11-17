import {key_tag, transform_keys, crypto_methods} from './codec.mjs';

const algorithm_fields = ['iv','nonce','additionalData','tagLength','counter','length','hash','salt','iterations','info','modulusLength','publicExponent','namedCurve','public','label','saltLength','context'];
const algorithm_positions = {encrypt:[0],decrypt:[0],sign:[0],verify:[0],digest:[0],generateKey:[0],deriveKey:[0,2],deriveBits:[0],importKey:[2],exportKey:[],wrapKey:[3],unwrapKey:[3,4],getPublicKey:[],encapsulateBits:[0],encapsulateKey:[0,2],decapsulateBits:[0],decapsulateKey:[0,3]};
const jwk_fields = ['kty','use','key_ops','alg','ext','crv','x','y','d','n','e','p','q','dp','dq','qi','oth','k'];
const arities = {encrypt:3,decrypt:3,sign:3,verify:4,digest:2,generateKey:3,deriveKey:5,deriveBits:3,importKey:5,exportKey:2,wrapKey:4,unwrapKey:7,getPublicKey:2,encapsulateBits:2,encapsulateKey:5,decapsulateBits:3,decapsulateKey:6};

export function create_crypto_client(dispatch, {methods = crypto_methods} = {}) {
  const clone = globalThis.structuredClone;
  const keys = new WeakMap();
  class CryptoKey {
    constructor() { throw new TypeError('Illegal constructor'); }
    get type() { return info(this).type; }
    get extractable() { return info(this).extractable; }
    get algorithm() { return info(this).algorithm; }
    get usages() { return info(this).usages; }
    get [Symbol.toStringTag]() { return 'CryptoKey'; }
  }
  const info = key => {
    const value = keys.get(key);
    if (!value) throw new TypeError('Invalid CryptoKey receiver');
    return value;
  };
  for (const name of ['type','extractable','algorithm','usages']) {
    Object.defineProperty(CryptoKey.prototype,name,{...Object.getOwnPropertyDescriptor(CryptoKey.prototype,name),enumerable:true});
  }
  Object.defineProperty(CryptoKey.prototype,Symbol.toStringTag,{value:'CryptoKey',configurable:true});
  const encode = value => transform_keys(value, value => keys.get(value) || value);
  const decode = value => transform_keys(value, value => {
    if (!Object.hasOwn(value, key_tag)) return value;
    const key = Object.create(CryptoKey.prototype);
    keys.set(key, value);return key;
  });
  function algorithm(value) {
    if (typeof value === 'string') return value;
    if (value === null || typeof value !== 'object') return value;
    const result = {name:value.name};
    for (const field of algorithm_fields) if (field in value) result[field] = field === 'hash' ? algorithm(value[field]) : value[field];
    return result;
  }
  class SubtleCrypto {
    constructor() { throw new TypeError('Illegal constructor'); }
    get [Symbol.toStringTag]() { return 'SubtleCrypto'; }
  }
  const subtle = Object.create(SubtleCrypto.prototype);
  Object.defineProperty(SubtleCrypto.prototype,Symbol.toStringTag,{value:'SubtleCrypto',configurable:true});
  for (const method of methods.filter(method=>crypto_methods.includes(method))) {
    const implementation = {[method]:async function(...args) {
      if (this !== subtle) throw new TypeError('Invalid SubtleCrypto receiver');
      for (const index of algorithm_positions[method]) if (index < args.length) args[index] = algorithm(args[index]);
      const usageIndex = {generateKey:2,deriveKey:4,importKey:4,unwrapKey:6,getPublicKey:1,encapsulateKey:4,decapsulateKey:5}[method];
      if (usageIndex !== undefined && usageIndex < args.length) args[usageIndex] = Array.from(args[usageIndex], String);
      if (method === 'importKey' && args[0] === 'jwk' && args[1] && typeof args[1] === 'object') {
        const source = args[1], value = {};
        for (const field of jwk_fields) if (field in source) value[field] = source[field];
        args[1] = value;
      }
      return decode(await dispatch(method, clone(encode(args))));
    }}[method];
    Object.defineProperty(implementation,'length',{value:arities[method]});
    Object.defineProperty(SubtleCrypto.prototype,method,{value:implementation,writable:true,configurable:true,enumerable:true});
  }
  return {subtle, CryptoKey, SubtleCrypto, encode, decode};
}
