// Opaque sandbox origins can hide randomUUID even though getRandomValues is
// available. Use that native CSPRNG and the Web Crypto v4 formatting algorithm.
export function install_random_uuid(crypto) {
  if (!crypto || typeof crypto.randomUUID === 'function' || typeof crypto.getRandomValues !== 'function') return;
  const random = crypto.getRandomValues;
  Object.defineProperty(Object.getPrototypeOf(crypto), 'randomUUID', {
    configurable: true, enumerable: true, writable: true,
    value: function randomUUID() {
      const bytes = new Uint8Array(16);
      Reflect.apply(random, this, [bytes]);
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    }
  });
}
