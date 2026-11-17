import {key_tag, transform_keys, crypto_methods} from './codec.mjs';

export class CryptoService {
  constructor(crypto = globalThis.crypto) {
    this.crypto = crypto;
    this.keys = new Map();
    this.ids = new WeakMap();
    this.Key = globalThis.CryptoKey;
  }
  get available() { return !!this.crypto?.subtle; }
  get methods() { return this.available ? crypto_methods.filter(method=>typeof this.crypto.subtle[method]==='function') : false; }
  encode(value) {
    return transform_keys(value, value => {
      if (!this.Key || !(value instanceof this.Key)) return value;
      let id = this.ids.get(value);
      if (!id) {
        const bytes = this.crypto.getRandomValues(new Uint8Array(24));
        id = Array.from(bytes, byte => byte.toString(16).padStart(2,'0')).join('');
        this.ids.set(value, id); this.keys.set(id, value);
      }
      return {[key_tag]:id,type:value.type,extractable:value.extractable,algorithm:value.algorithm,usages:value.usages};
    });
  }
  decode(value) {
    return transform_keys(value, value => {
      if (!Object.hasOwn(value, key_tag)) return value;
      const key = this.keys.get(value[key_tag]);
      if (!key) throw new DOMException('Unknown cryptographic key', 'DataCloneError');
      return key;
    });
  }
  async call(method, args) {
    if (!this.available) throw new DOMException('Web Crypto is unavailable in the host', 'NotSupportedError');
    if (!crypto_methods.includes(method) || typeof this.crypto.subtle[method] !== 'function') throw new DOMException('Unsupported cryptographic operation', 'NotSupportedError');
    return this.encode(await Reflect.apply(this.crypto.subtle[method], this.crypto.subtle, this.decode(args)));
  }
}
