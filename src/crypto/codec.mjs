export const key_tag = '__sandstone_crypto_key_v1__';

// Walk only structured data containers. Leave binary buffers, Blob, dates,
// errors, ports, etc. to native structured cloning, including transfer lists.
export function transform_keys(value, convert, seen = new Map()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const converted = convert(value);
  if (converted !== value) { seen.set(value, converted); return converted; }
  let copy;
  if (Array.isArray(value)) copy = new Array(value.length);
  else if (value instanceof Map) copy = new Map();
  else if (value instanceof Set) copy = new Set();
  else if (Object.prototype.toString.call(value) === '[object Object]') copy = {};
  else return value;
  seen.set(value, copy);
  if (value instanceof Map) for (const [key, item] of value) copy.set(transform_keys(key, convert, seen), transform_keys(item, convert, seen));
  else if (value instanceof Set) for (const item of value) copy.add(transform_keys(item, convert, seen));
  else for (const key of Object.keys(value)) Object.defineProperty(copy, key, {value:transform_keys(value[key],convert,seen),enumerable:true,writable:true,configurable:true});
  return copy;
}

export const crypto_methods = ['encrypt','decrypt','sign','verify','digest','generateKey','deriveKey','deriveBits','importKey','exportKey','wrapKey','unwrapKey','getPublicKey','encapsulateBits','encapsulateKey','decapsulateBits','decapsulateKey'];
