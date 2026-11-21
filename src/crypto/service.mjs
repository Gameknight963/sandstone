import {key_tag, key_handle, key_metadata, transform_keys, crypto_methods} from './codec.mjs';
const clone=globalThis.structuredClone;
const invalid_key=()=>new DOMException('Unknown cryptographic key','DataCloneError');
function handles(value){
  const found=new Map();
  transform_keys(value,value=>{const metadata=key_metadata(value);if(metadata&&!found.has(metadata[key_tag]))found.set(metadata[key_tag],{handle:value,metadata});return value;});
  return [...found.values()];
}
const metadata_matches=(metadata,key)=>metadata.type===key.type&&metadata.extractable===key.extractable&&JSON.stringify(metadata.algorithm)===JSON.stringify(key.algorithm)&&JSON.stringify(metadata.usages)===JSON.stringify(key.usages);

export class CryptoService {
  constructor(crypto = globalThis.crypto) {
    this.crypto = crypto;
    this.keys = new Map();
    this.ids = new WeakMap();
    this.Key = globalThis.CryptoKey;
  }
  get available() { return !!this.crypto?.subtle; }
  get methods() { return this.available ? crypto_methods.filter(method=>typeof this.crypto.subtle[method]==='function') : false; }
  // A vault is a private host capability, never a renderer's crypto RPC. Keep
  // original IDs so ports can move between renderers without rewriting keys.
  setVault(vault){
    if(!vault||typeof vault.store!=='function'||typeof vault.load!=='function')throw new TypeError('A private crypto vault is required');
    const state={vault,published:new Map()};this.vault=state;
    return ()=>{if(this.vault===state)this.vault=undefined;};
  }
  store(records){
    if(!Array.isArray(records))throw new TypeError('A native key list is required');
    const checked=records.map(({handle,key})=>{
      const metadata=key_metadata(handle);
      if(!metadata||!this.Key||!(key instanceof this.Key)||!metadata_matches(metadata,key))throw invalid_key();
      const existing=this.keys.get(metadata[key_tag]);if(existing&&!metadata_matches(metadata,existing))throw invalid_key();
      return {id:metadata[key_tag],key};
    });
    for(const {id,key} of checked){if(!this.keys.has(id))this.keys.set(id,key);this.ids.set(key,id);}
  }
  load(values){
    if(!Array.isArray(values))throw new TypeError('A key handle list is required');
    return values.map(value=>{const metadata=key_metadata(value);if(!metadata)throw invalid_key();return this.keys.get(metadata[key_tag])||null;});
  }
  publish_keys(value){
    const state=this.vault;if(!state)return value;
    const list=value===undefined?[...this.keys].map(([id,key])=>({handle:key_handle({[key_tag]:id,type:key.type,extractable:key.extractable,algorithm:key.algorithm,usages:key.usages}),metadata:{[key_tag]:id}})):handles(value);
    const records=list.filter(({metadata})=>this.keys.has(metadata[key_tag])&&!state.published.has(metadata[key_tag])).map(({handle,metadata})=>({handle,key:this.keys.get(metadata[key_tag])}));
    if(records.length){
      const writing=Promise.resolve().then(()=>state.vault.store(records)).catch(error=>{
        for(const {handle} of records)if(state.published.get(key_metadata(handle)[key_tag])===writing)state.published.delete(key_metadata(handle)[key_tag]);
        throw error;
      });
      for(const {handle} of records)state.published.set(key_metadata(handle)[key_tag],writing);
    }
    const pending=list.map(({metadata})=>state.published.get(metadata[key_tag])).filter(Boolean);
    return pending.length?Promise.all(pending).then(()=>value):value;
  }
  encode_shared(value){return this.publish_keys(this.encode(value));}
  decode_shared(value){
    const state=this.vault;if(!state)return this.decode(value);
    const missing=handles(value).filter(({metadata})=>!this.keys.has(metadata[key_tag]));
    if(!missing.length)return this.decode(value);
    return Promise.resolve().then(()=>state.vault.load(missing.map(({handle})=>handle))).then(async keys=>{
      if(!Array.isArray(keys)||keys.length!==missing.length||keys.some(key=>!key))throw invalid_key();
      this.store(missing.map(({handle},index)=>({handle,key:keys[index]})));
      for(const {metadata} of missing)state.published.set(metadata[key_tag],Promise.resolve());
      await this.publish_keys(value);return this.decode(value);
    });
  }
  encode(value) {
    return transform_keys(value, value => {
      if (!this.Key || !(value instanceof this.Key)) return value;
      let id = this.ids.get(value);
      if (!id) {
        const bytes = this.crypto.getRandomValues(new Uint8Array(24));
        id = Array.from(bytes, byte => byte.toString(16).padStart(2,'0')).join('');
        this.ids.set(value, id); this.keys.set(id, value);
      }
      return key_handle({[key_tag]:id,type:value.type,extractable:value.extractable,algorithm:value.algorithm,usages:value.usages});
    });
  }
  decode(value) {
    return transform_keys(value, value => {
      const metadata=key_metadata(value);if(!metadata)return value;
      const key = this.keys.get(metadata[key_tag]);
      if (!key) throw new DOMException('Unknown cryptographic key', 'DataCloneError');
      // Each distinct serialized handle is a separate key object, even when
      // its material and capability match another handle. The graph traversal
      // still reuses this clone for repeated references to that same handle.
      return clone(key);
    });
  }
  async call(method, args) {
    if (!this.available) throw new DOMException('Web Crypto is unavailable in the host', 'NotSupportedError');
    if (!crypto_methods.includes(method) || typeof this.crypto.subtle[method] !== 'function') throw new DOMException('Unsupported cryptographic operation', 'NotSupportedError');
    return this.encode_shared(await Reflect.apply(this.crypto.subtle[method], this.crypto.subtle, await this.decode_shared(args)));
  }
}
