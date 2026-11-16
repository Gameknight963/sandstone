import { IDBFactory as KeyFactory, IDBKeyRange } from "fake-indexeddb";
export { IDBKeyRange };
const keys = new KeyFactory();
const fail = (name, message = name) => { throw new DOMException(message, name); };
const unpack_error = data => new DOMException(data?.message || "Database error", data?.name || "UnknownError");
const clone = value => structuredClone(value);

export class IDBVersionChangeEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    this.oldVersion = init.oldVersion || 0;
    this.newVersion = init.newVersion ?? null;
  }
  get [Symbol.toStringTag]() { return "IDBVersionChangeEvent"; }
}

function names(values) {
  const list = [...values].sort();
  Object.defineProperties(list, {
    contains: {value: name => list.includes(String(name))},
    item: {value: index => list[Number(index) >>> 0] ?? null},
    [Symbol.toStringTag]: {value: "DOMStringList"}
  });
  return list;
}

function query(value) {
  if (value instanceof IDBKeyRange) return {
    __sandstone_range__: true, lower: value.lower, upper: value.upper,
    lowerOpen: value.lowerOpen, upperOpen: value.upperOpen
  };
  if (value !== undefined && value !== null) keys.cmp(value, value);
  return value;
}

class IDBEventTarget extends EventTarget {
  constructor(events) {
    super();
    for (const type of events) {
      let handler;
      Object.defineProperty(this, "on" + type, {
        configurable: true, enumerable: true,
        get: () => handler?.original || null,
        set: value => {
          if (handler) this.removeEventListener(type, handler);
          handler = typeof value === "function" ? event => {
            try { if (value.call(this, event) === false) event.preventDefault(); }
            catch (error) {
              const tx = this.transaction || (this instanceof IDBTransaction ? this : null);
              tx?._abort(new DOMException("An event handler threw", "AbortError"));
              if (typeof reportError === "function") reportError(error);
            }
          } : null;
          if (handler) { handler.original = value; this.addEventListener(type, handler); }
        }
      });
    }
  }

  _emit(type, details = {}, bubbles = false, cancelable = false) {
    const EventType = typeof details.oldVersion === "number" ? IDBVersionChangeEvent : Event;
    const event = new EventType(type, {...details, bubbles, cancelable});
    for (const [key, value] of Object.entries(details)) Object.defineProperty(event, key, {value, configurable: true});
    Object.defineProperty(event, "target", {value: this});
    let current = this;
    do {
      current.dispatchEvent(event);
      current = bubbles && !event.cancelBubble ? current instanceof IDBRequest ? current.transaction : current instanceof IDBTransaction ? current.db : null : null;
    } while (current);
    return event;
  }
}

export class IDBRequest extends IDBEventTarget {
  constructor(factory, source = null, transaction = null, events = ["success", "error"]) {
    super(events);
    this.source = source;
    this.transaction = transaction;
    this.readyState = "pending";
    this._factory = factory;
    this._id = factory._register(this);
    this._result = undefined;
    this._error = null;
  }
  get result() { if (this.readyState === "pending") fail("InvalidStateError"); return this._result; }
  get error() { if (this.readyState === "pending") fail("InvalidStateError"); return this._error; }
  get [Symbol.toStringTag]() { return "IDBRequest"; }
}

export class IDBOpenDBRequest extends IDBRequest {
  constructor(factory) {
    super(factory, null, null, ["success", "error", "blocked", "upgradeneeded"]);
  }
  get [Symbol.toStringTag]() { return "IDBOpenDBRequest"; }
}

export class IDBTransaction extends IDBEventTarget {
  constructor(factory, database, stores, mode, id, options = {}) {
    super(["complete", "abort", "error"]);
    this.db = database;
    this.mode = mode;
    this.durability = options.durability || "default";
    this.error = null;
    this._factory = factory;
    this._id = factory._register(this, id);
    this._scope = [...stores];
    this._stores = new Map();
    this._pending = 0;
    this._commands = 0;
    this._finished = false;
    this._ending = false;
    this._released = false;
    this._active = true;
    this._generation = 0;
    this._activate();
  }
  get objectStoreNames() { return names(this.mode === "versionchange" ? this.db._stores.keys() : this._scope); }
  objectStore(name) {
    if (this._finished) fail("InvalidStateError");
    name = String(name);
    if (!this.objectStoreNames.contains(name)) fail("NotFoundError");
    if (!this._stores.has(name)) this._stores.set(name, new IDBObjectStore(this, this.db._stores.get(name)));
    return this._stores.get(name);
  }
  _assert(write = false) {
    if (!this._active || this._finished || this._ending) fail("TransactionInactiveError");
    if (write && this.mode === "readonly") fail("ReadOnlyError");
  }
  _activate() {
    this._active = true;
    const generation = ++this._generation;
    setTimeout(() => {
      if (generation !== this._generation) return;
      this._active = false;
      this._settle();
    }, 0);
  }
  _settle() {
    if (this._finished || this._released || this._commands) return;
    if ((!this._active && !this._pending) || this._commitRequested) {
      this._released = true;
      this._factory._send({op: "release", transaction: this._id});
    }
  }
  _command(command) {
    this._commands++;
    this._factory._send({...command, transaction: this._id}).finally(() => { this._commands--; this._settle(); });
  }
  _request(source, method, args, cursor) {
    this._assert(["put", "add", "delete", "clear", "update"].includes(method));
    const request = new IDBRequest(this._factory, source, this);
    this._pending++;
    const store = source instanceof IDBIndex ? source.objectStore : source instanceof IDBCursor ? source._store : source;
    const index = source instanceof IDBIndex ? source.name : source instanceof IDBCursor ? source._index : undefined;
    this._command({op: "request", request: request._id, store: store.name, index, method, args: clone(args), cursor});
    return request;
  }
  _abort(error) {
    if (this._finished || this._ending) return;
    this.error = error;
    this._ending = true;
    this._active = false;
    this._factory._send({op: "abort", transaction: this._id});
  }
  abort() {
    if (this._finished || this._ending) fail("InvalidStateError");
    this._userAborted = true;
    this._abort(null);
  }
  commit() {
    this._assert();
    this._ending = true;
    this._commitRequested = true;
    this._settle();
  }
  get [Symbol.toStringTag]() { return "IDBTransaction"; }
}

export class IDBDatabase extends IDBEventTarget {
  constructor(factory, descriptor) {
    super(["abort", "close", "error", "versionchange"]);
    this._factory = factory;
    this._id = factory._register(this, descriptor.id);
    this.name = descriptor.name;
    this.version = descriptor.version;
    this._stores = new Map(descriptor.stores.map(store => [store.name, store]));
    this._closed = false;
  }
  get objectStoreNames() { return names(this._stores.keys()); }
  _upgrade() {
    if (!this._upgradeTransaction || this._upgradeTransaction._finished) fail("InvalidStateError");
    this._upgradeTransaction._assert();
    return this._upgradeTransaction;
  }
  createObjectStore(name, options = {}) {
    const tx = this._upgrade();
    name = String(name);
    if (this._stores.has(name)) fail("ConstraintError");
    const keyPath = options.keyPath ?? null;
    if (options.autoIncrement && (keyPath === "" || Array.isArray(keyPath))) fail("InvalidAccessError");
    const meta = {name, keyPath: clone(keyPath), autoIncrement: !!options.autoIncrement, indexes: []};
    this._stores.set(name, meta);
    tx._command({op: "schema", method: "createObjectStore", store: name, options: clone(options)});
    return tx.objectStore(name);
  }
  deleteObjectStore(name) {
    const tx = this._upgrade();
    name = String(name);
    if (!this._stores.has(name)) fail("NotFoundError");
    this._stores.delete(name);
    tx._command({op: "schema", method: "deleteObjectStore", store: name});
  }
  transaction(stores, mode = "readonly", options = {}) {
    if (this._closed || (this._upgradeTransaction && !this._upgradeTransaction._finished)) fail("InvalidStateError");
    if (!["readonly", "readwrite"].includes(mode)) throw new TypeError("Invalid transaction mode");
    if (![undefined, "default", "strict", "relaxed"].includes(options.durability)) throw new TypeError("Invalid durability");
    stores = typeof stores === "string" ? [stores] : [...stores].map(String);
    if (!stores.length) fail("InvalidAccessError");
    for (const store of stores) if (!this._stores.has(store)) fail("NotFoundError");
    const tx = new IDBTransaction(this._factory, this, [...new Set(stores)], mode, undefined, options);
    tx._command({op: "transaction", database: this._id, stores, mode, options});
    return tx;
  }
  close() {
    if (this._closed) return;
    this._closed = true;
    this._factory._send({op: "close", database: this._id});
    this._factory._objects.delete(this._id);
  }
  get [Symbol.toStringTag]() { return "IDBDatabase"; }
}

export class IDBObjectStore {
  constructor(transaction, meta) { this.transaction = transaction; this._meta = meta; this._indexes = new Map(); }
  get name() { return this._meta.name; }
  set name(value) {
    const tx = this.transaction;
    tx.db._upgrade();
    value = String(value);
    if (value === this.name) return;
    if (tx.db._stores.has(value)) fail("ConstraintError");
    const old = this.name;
    tx.db._stores.delete(old);
    tx._stores.delete(old);
    this._meta.name = value;
    tx.db._stores.set(value, this._meta);
    tx._stores.set(value, this);
    tx._command({op: "schema", method: "renameStore", store: old, name: value});
  }
  get keyPath() { return this._meta.keyPath; }
  get autoIncrement() { return this._meta.autoIncrement; }
  get indexNames() { return names(this._meta.indexes.map(index => index.name)); }
  _alive() { if (this.transaction._finished || !this.transaction.db._stores.has(this.name)) fail("InvalidStateError"); }
  index(name) {
    this._alive();
    name = String(name);
    const meta = this._meta.indexes.find(index => index.name === name);
    if (!meta) fail("NotFoundError");
    if (!this._indexes.has(name)) this._indexes.set(name, new IDBIndex(this, meta));
    return this._indexes.get(name);
  }
  createIndex(name, keyPath, options = {}) {
    this.transaction.db._upgrade();
    this._alive();
    name = String(name);
    if (this.indexNames.contains(name)) fail("ConstraintError");
    if (Array.isArray(keyPath) && options.multiEntry) fail("InvalidAccessError");
    const meta = {name, keyPath: clone(keyPath), unique: !!options.unique, multiEntry: !!options.multiEntry};
    this._meta.indexes.push(meta);
    this.transaction._command({op: "schema", method: "createIndex", store: this.name, name, keyPath: clone(keyPath), options: clone(options)});
    return this.index(name);
  }
  deleteIndex(name) {
    this.transaction.db._upgrade();
    this._alive();
    name = String(name);
    if (!this.indexNames.contains(name)) fail("NotFoundError");
    this._meta.indexes = this._meta.indexes.filter(index => index.name !== name);
    this._indexes.delete(name);
    this.transaction._command({op: "schema", method: "deleteIndex", store: this.name, name});
  }
  _write(method, value, key) {
    this._alive();
    this.transaction._assert(true);
    const copy = clone(value);
    if (this.keyPath !== null) {
      if (key !== undefined) fail("DataError");
      const read = path => path === "" ? copy : path.split(".").reduce((object, part) => object?.[part], copy);
      const inline = Array.isArray(this.keyPath) ? this.keyPath.map(read) : read(this.keyPath);
      if (inline !== undefined) keys.cmp(inline, inline);
      else if (!this.autoIncrement) fail("DataError");
    } else if (key === undefined && !this.autoIncrement) fail("DataError");
    if (key !== undefined) keys.cmp(key, key);
    return this.transaction._request(this, method, key === undefined ? [copy] : [copy, key]);
  }
  put(value, key) { return this._write("put", value, key); }
  add(value, key) { return this._write("add", value, key); }
  get [Symbol.toStringTag]() { return "IDBObjectStore"; }
}

export class IDBIndex {
  constructor(store, meta) { this.objectStore = store; this._meta = meta; }
  get name() { return this._meta.name; }
  set name(value) {
    const store = this.objectStore;
    store.transaction.db._upgrade();
    value = String(value);
    if (value === this.name) return;
    if (store.indexNames.contains(value)) fail("ConstraintError");
    const old = this.name;
    this._meta.name = value;
    store._indexes.delete(old);
    store._indexes.set(value, this);
    store.transaction._command({op: "schema", method: "renameIndex", store: store.name, index: old, name: value});
  }
  get keyPath() { return this._meta.keyPath; }
  get unique() { return this._meta.unique; }
  get multiEntry() { return this._meta.multiEntry; }
  get [Symbol.toStringTag]() { return "IDBIndex"; }
}

for (const prototype of [IDBObjectStore.prototype, IDBIndex.prototype]) {
  for (const method of ["get", "getKey", "getAll", "getAllKeys", "count", "openCursor", "openKeyCursor", "delete", "clear"]) {
    if (prototype === IDBIndex.prototype && ["delete", "clear"].includes(method)) continue;
    Object.defineProperty(prototype, method, {value: function(...args) {
      const store = this instanceof IDBIndex ? this.objectStore : this;
      store._alive();
      if (["get", "getKey", "delete"].includes(method) && !args.length) throw new TypeError("A key is required");
      if (args.length && method !== "clear") args[0] = query(args[0]);
      if (["openCursor", "openKeyCursor"].includes(method) && args[1] !== undefined && !["next", "prev", "nextunique", "prevunique"].includes(args[1])) throw new TypeError("Invalid cursor direction");
      return store.transaction._request(this, method, args);
    }, writable: true, configurable: true});
  }
}

export class IDBCursor {
  constructor(request, descriptor) {
    this.request = request;
    this.source = request.source;
    this._store = this.source instanceof IDBIndex ? this.source.objectStore : this.source;
    this._index = this.source instanceof IDBIndex ? this.source.name : undefined;
    this._id = request._id;
    this._refresh(descriptor);
  }
  _refresh(descriptor) { Object.assign(this, descriptor); this._gotValue = true; }
  _move(method, args) {
    const tx = this.request.transaction;
    tx._assert();
    if (!this._gotValue) fail("InvalidStateError");
    this._gotValue = false;
    this.request.readyState = "pending";
    tx._pending++;
    tx._command({op: "cursor", cursor: this._id, request: this._id, method, args: clone(args)});
  }
  continue(key) {
    if (key !== undefined) {
      const order = keys.cmp(key, this.key);
      if (this.direction.startsWith("next") ? order <= 0 : order >= 0) fail("DataError");
    }
    this._move("continue", key === undefined ? [] : [key]);
  }
  advance(count) {
    count = Math.trunc(Number(count));
    if (!(count > 0 && count <= 0xffffffff)) throw new TypeError("Invalid cursor advance count");
    this._move("advance", [count]);
  }
  continuePrimaryKey(key, primaryKey) { keys.cmp(key, key); keys.cmp(primaryKey, primaryKey); this._move("continuePrimaryKey", [key, primaryKey]); }
  update(value) {
    if (!this._gotValue) fail("InvalidStateError");
    return this.request.transaction._request(this, "update", [clone(value)], this._id);
  }
  delete() {
    if (!this._gotValue) fail("InvalidStateError");
    return this.request.transaction._request(this, "delete", [], this._id);
  }
  get [Symbol.toStringTag]() { return "IDBCursor"; }
}

export class IDBCursorWithValue extends IDBCursor {
  get [Symbol.toStringTag]() { return "IDBCursorWithValue"; }
}

export class IDBFactory {
  constructor(transport) {
    this._transport = transport;
    this._objects = new Map();
    this._sequence = 0;
    this._polling = false;
  }
  _register(object, id = "idb:" + ++this._sequence) { this._objects.set(id, object); return id; }
  _send(command) {
    this._start();
    return Promise.resolve(this._transport.command(command)).catch(error => {
      this._event({target: command.request || command.transaction, type: "error", error: {name: error.name, message: error.message}});
    });
  }
  async _start() {
    if (this._polling) return;
    this._polling = true;
    try {
      while (this._polling) {
        const events = await this._transport.poll();
        if (events === null) { this._shutdown(); break; }
        for (const event of events) this._event(event);
      }
    } catch (error) {
      this._shutdown(error);
    } finally { this._polling = false; }
  }
  _shutdown(error = new DOMException("Database connection closed", "AbortError")) {
    for (const object of this._objects.values()) {
      if (object instanceof IDBRequest && object.readyState === "pending") {
        object.readyState = "done"; object._error = error; object._emit("error", {}, true, true);
      } else if (object instanceof IDBTransaction && !object._finished) {
        object._finished = true; object.error = error; object._emit("abort", {}, true);
      } else if (object instanceof IDBDatabase && !object._closed) {
        object._closed = true; object._emit("close");
      }
    }
    this._objects.clear();
  }
  _event(event) {
    const object = this._objects.get(event.target);
    if (!object) return;
    if (object instanceof IDBRequest) {
      const tx = object.transaction;
      if (event.type === "upgradeneeded" || event.resultKind === "database") {
        const descriptor = event.value;
        let db = this._objects.get(descriptor.id);
        if (!(db instanceof IDBDatabase)) db = new IDBDatabase(this, descriptor);
        else { db.version = descriptor.version; db._stores = new Map(descriptor.stores.map(store => [store.name, store])); }
        object._result = db;
        if (event.type === "upgradeneeded") {
          object.transaction = db._upgradeTransaction = new IDBTransaction(this, db, descriptor.stores.map(store => store.name), "versionchange", event.transaction);
        }
      } else if (event.resultKind === "cursor") {
        const Cursor = "value" in event.value ? IDBCursorWithValue : IDBCursor;
        if (object._result instanceof IDBCursor) object._result._refresh(event.value);
        else object._result = new Cursor(object, event.value);
      } else if (event.type === "success") object._result = event.value;
      if (event.type === "blocked") { object._emit("blocked", {oldVersion: event.oldVersion, newVersion: event.newVersion}); return; }
      object.readyState = "done";
      if (event.type === "error") object._error = unpack_error(event.error);
      if (tx && !(object instanceof IDBOpenDBRequest)) { tx._pending--; tx._activate(); }
      if (object instanceof IDBOpenDBRequest && event.type !== "upgradeneeded") object.transaction = null;
      const emitted = object._emit(event.type, {oldVersion: event.oldVersion, newVersion: event.newVersion}, event.type === "error", event.type === "error");
      if (event.type === "error" && tx && !emitted.defaultPrevented) tx._abort(object._error);
      if (event.type !== "upgradeneeded" && !(object._result instanceof IDBCursor)) this._objects.delete(object._id);
    } else if (object instanceof IDBTransaction) {
      if (event.type === "error") { object._abort(unpack_error(event.error)); return; }
      if (event.type === "complete" || event.type === "abort") {
        object._finished = true;
        object._active = false;
        if (event.type === "abort" && !object.error && !object._userAborted) object.error = unpack_error(event.error);
        object._emit(event.type, {}, event.type === "abort");
        this._objects.delete(object._id);
        for (const [id, request] of this._objects) {
          if (request instanceof IDBRequest && !(request instanceof IDBOpenDBRequest) && request.transaction === object) this._objects.delete(id);
        }
      }
    } else object._emit(event.type, {oldVersion: event.oldVersion, newVersion: event.newVersion});
  }
  open(name, version) {
    if (!arguments.length) throw new TypeError("A database name is required");
    if (version !== undefined) {
      version = Math.trunc(Number(version));
      if (!(version > 0 && version <= Number.MAX_SAFE_INTEGER)) throw new TypeError("Invalid database version");
    }
    const request = new IDBOpenDBRequest(this);
    this._send({op: "open", request: request._id, database: "idb:" + ++this._sequence, transaction: "idb:" + ++this._sequence, name: String(name), version});
    return request;
  }
  deleteDatabase(name) {
    if (!arguments.length) throw new TypeError("A database name is required");
    const request = new IDBOpenDBRequest(this);
    this._send({op: "delete", request: request._id, name: String(name)});
    return request;
  }
  databases() { return this._transport.databases(); }
  cmp(first, second) { return keys.cmp(first, second); }
  get [Symbol.toStringTag]() { return "IDBFactory"; }
}
