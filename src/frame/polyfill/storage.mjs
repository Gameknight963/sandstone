// Keep this independent of the frame runtime so Storage semantics can be tested.
export class FakeStorage {
  #map;
  #sync;

  constructor(entries = [], sync = () => {}) {
    this.#map = new Map(entries);
    this.#sync = sync;
    return new Proxy(this, {
      get: (target, key) => {
        if (typeof key === "symbol") return Reflect.get(target, key, target);
        if (key in target) {
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return this.#map.get(key);
      },
      set: (target, key, value) => {
        if (typeof key !== "string") return Reflect.set(target, key, value, target);
        this.setItem(key, value);
        return true;
      },
      deleteProperty: (target, key) => { this.removeItem(key); return true; },
      ownKeys: () => [...this.#map.keys()],
      has: (target, key) => key in target || this.#map.has(key),
      getOwnPropertyDescriptor: (target, key) => this.#map.has(key) ? {
        value: this.#map.get(key), writable: true, enumerable: true, configurable: true
      } : Reflect.getOwnPropertyDescriptor(target, key)
    });
  }

  get length() { return this.#map.size; }
  key(index) { return [...this.#map.keys()][Number(index) >>> 0] ?? null; }
  getItem(key) { return this.#map.get(String(key)) ?? null; }
  setItem(key, value) {
    this.#map.set(String(key), String(value));
    this.#sync(this._get_entries());
  }
  removeItem(key) {
    this.#map.delete(String(key));
    this.#sync(this._get_entries());
  }
  clear() { this.#map.clear(); this.#sync([]); }
  _get_entries() { return [...this.#map]; }
  toString() { return "[object Storage]"; }
  get [Symbol.toStringTag]() { return "Storage"; }
}
