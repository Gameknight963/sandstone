export const key_tag = '__sandstone_crypto_key_v1__';
const handle_type='application/x-sandstone-cryptokey;v=1;data=';
const blob_type=Object.getOwnPropertyDescriptor(Blob.prototype,'type').get;
const prototype=Object.getPrototypeOf,object_prototype=Object.prototype;
const map_each=Map.prototype.forEach,map_set=Map.prototype.set,set_each=Set.prototype.forEach,set_add=Set.prototype.add;
const hex=value=>Array.from(new TextEncoder().encode(value),byte=>byte.toString(16).padStart(2,'0')).join('');
export function key_handle(metadata){
  // Blob's internal slots survive native structured cloning even in insecure
  // opaque documents, where CryptoKey itself cannot be deserialized. No key
  // material is present: only the host capability and public metadata.
  const algorithm={...metadata.algorithm};
  if(algorithm.publicExponent)algorithm.publicExponent=[...algorithm.publicExponent];
  return new Blob([],{type:handle_type+hex(JSON.stringify({...metadata,algorithm}))});
}
export function key_metadata(value){
  let type;try{type=Reflect.apply(blob_type,value,[]);}catch{return;}
  if(!type.startsWith(handle_type))return;
  const encoded=type.slice(handle_type.length);
  if(!/^(?:[0-9a-f]{2})+$/.test(encoded))return;
  try{
    const metadata=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(encoded.match(/../g),byte=>parseInt(byte,16))));
    if(!/^[0-9a-f]{48}$/.test(metadata?.[key_tag])||!['secret','public','private'].includes(metadata.type)||typeof metadata.extractable!=='boolean'||!metadata.algorithm||typeof metadata.algorithm.name!=='string'||!Array.isArray(metadata.usages)||!metadata.usages.every(usage=>typeof usage==='string'))return;
    if(metadata.algorithm.publicExponent)metadata.algorithm.publicExponent=new Uint8Array(metadata.algorithm.publicExponent);
    return metadata;
  }catch{return;}
}

// Walk already-cloned data containers and native crypto results. Never run
// this traversal over authored message input before native serialization.
export function transform_keys(value, convert, seen = new Map()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const converted = convert(value);
  if (converted !== value) { seen.set(value, converted); return converted; }
  let copy;
  if (Array.isArray(value)) copy = new Array(value.length);
  else if (value instanceof Map) copy = new Map();
  else if (value instanceof Set) copy = new Set();
  else if (value instanceof Error) copy = value;
  else if (prototype(value)===object_prototype||prototype(value)===null) copy = {};
  else {seen.set(value,value);return value;}
  seen.set(value, copy);
  if (value instanceof Map) Reflect.apply(map_each,value,[(item,key)=>Reflect.apply(map_set,copy,[transform_keys(key,convert,seen),transform_keys(item,convert,seen)])]);
  else if (value instanceof Set) Reflect.apply(set_each,value,[item=>Reflect.apply(set_add,copy,[transform_keys(item,convert,seen)])]);
  else if (value instanceof Error) {
    const cause=Object.getOwnPropertyDescriptor(value,'cause');
    if(cause)Object.defineProperty(copy,'cause',{...cause,value:transform_keys(cause.value,convert,seen)});
  }
  else for (const key of Object.keys(value)) Object.defineProperty(copy, key, {value:transform_keys(value[key],convert,seen),enumerable:true,writable:true,configurable:true});
  return copy;
}

export const crypto_methods = ['encrypt','decrypt','sign','verify','digest','generateKey','deriveKey','deriveBits','importKey','exportKey','wrapKey','unwrapKey','getPublicKey','encapsulateBits','encapsulateKey','decapsulateBits','decapsulateKey'];
