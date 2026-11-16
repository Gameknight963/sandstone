import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

const prefix = "sandstone:idb:";
const keeper = "\u0000sandstone:transaction";
const physical_store = name => "s:" + name;
const error_data = error => ({name: error?.name || "UnknownError", message: error?.message || String(error)});
const database_name = (origin, name) => prefix + JSON.stringify([origin, name]);

function schema(database) {
  const names = [...database.objectStoreNames].filter(name => name !== keeper);
  if (!names.length) return [];
  const tx = database.transaction(names);
  return names.map(name => describe_store(tx.objectStore(name)));
}

function describe_store(store) {
  return {
    name: store.name.slice(2), keyPath: store.keyPath, autoIncrement: store.autoIncrement,
    indexes: [...store.indexNames].map(name => {
      const index = store.index(name);
      return {name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry};
    })
  };
}

function decode_key(value, Range) {
  if (!value?.__sandstone_range__) return value;
  const {lower, upper, lowerOpen, upperOpen} = value;
  if (lower === undefined) return Range.upperBound(upper, upperOpen);
  if (upper === undefined) return Range.lowerBound(lower, lowerOpen);
  return Range.bound(lower, upper, lowerOpen, upperOpen);
}

// All native IDB operations run in the host. The page sees only origin-scoped handles.
export class IndexedDBService {
  constructor(factory, {Range = IDBKeyRange, onCatalog = () => {}, known = []} = {}) {
    this.factory = factory;
    this.Range = Range;
    this.onCatalog = onCatalog;
    this.known = [...known];
    this.clients = new Map();
    this.persistent = !!factory;
    this.ready = this.probe(factory);
  }

  async probe(factory) {
    if (factory) {
      try {
        await new Promise((resolve, reject) => {
          const request = factory.open(prefix + "probe");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => { request.result.close(); resolve(); };
        });
        factory.deleteDatabase(prefix + "probe");
        return;
      } catch {}
    }
    this.factory = new IDBFactory();
    this.Range = IDBKeyRange;
    this.persistent = false;
    this.known = [];
  }

  client(id, origin) {
    let client = this.clients.get(id);
    if (client && client.origin !== origin) { this.disconnect(id); client = null; }
    if (!client) {
      client = {id, origin, objects: new Map(), transactions: new Map(), events: [], waiter: null, active: true};
      this.clients.set(id, client);
    }
    return client;
  }

  emit(client, event) {
    if (!client.active) return;
    client.events.push(event);
    if (client.waiter) {
      const resolve = client.waiter;
      client.waiter = null;
      resolve(client.events.splice(0));
    }
  }

  poll(id, origin) {
    const client = this.client(id, origin);
    if (client.events.length) return Promise.resolve(client.events.splice(0));
    return new Promise(resolve => { client.waiter = resolve; });
  }

  disconnect(id) {
    const client = this.clients.get(id);
    if (!client) return;
    client.active = false;
    for (const record of client.transactions.values()) {
      record.holding = false;
      try { record.tx.abort(); } catch {}
      for (const operation of record.queue.splice(0)) operation.reject(new DOMException("Connection closed", "AbortError"));
    }
    for (const object of client.objects.values()) {
      if (typeof object.close === "function") object.close();
    }
    client.waiter?.(null);
    this.clients.delete(id);
  }

  hold(client, tx, id) {
    const record = {tx, holding: true, queue: []};
    client.transactions.set(id, record);
    const cleanup = () => {
      for (const [handle, object] of client.objects) {
        if (object?.source?.transaction === tx || object?.source?.objectStore?.transaction === tx) client.objects.delete(handle);
      }
    };
    tx.addEventListener("complete", () => {
      client.transactions.delete(id);
      cleanup();
      this.emit(client, {target: id, type: "complete"});
    });
    tx.addEventListener("abort", () => {
      record.holding = false;
      client.transactions.delete(id);
      cleanup();
      for (const operation of record.queue.splice(0)) operation.reject(tx.error || new DOMException("Transaction aborted", "AbortError"));
      this.emit(client, {target: id, type: "abort", error: error_data(tx.error || new DOMException("Transaction aborted", "AbortError"))});
    });
    const step = () => {
      if (!record.holding) return;
      const request = tx.objectStore(keeper).get(0);
      request.onsuccess = () => {
        for (const operation of record.queue.splice(0)) {
          try { operation.resolve(operation.run()); }
          catch (error) { operation.reject(error); }
        }
        step();
      };
    };
    step();
    return record;
  }

  enqueue(client, txid, run) {
    const record = client.transactions.get(txid);
    if (!record?.holding) return Promise.reject(new DOMException("Transaction is inactive", "TransactionInactiveError"));
    return new Promise((resolve, reject) => record.queue.push({run: () => run(record.tx), resolve, reject}));
  }

  request(client, request, cmd, cursor = false) {
    request.onsuccess = () => {
      const result = request.result;
      let value = result;
      if (cursor && result) {
        client.objects.set(cmd.request, result);
        value = {key: result.key, primaryKey: result.primaryKey, direction: result.direction};
        if ("value" in result) value.value = result.value;
      }
      this.emit(client, {target: cmd.request, type: "success", resultKind: cursor && result ? "cursor" : "value", value});
    };
    request.onerror = event => {
      // The remote error handler must get a chance to prevent the default abort.
      event.preventDefault();
      event.stopPropagation();
      this.emit(client, {target: cmd.request, type: "error", error: error_data(request.error)});
    };
  }

  describe(database, id) {
    const stores = schema(database);
    return {id, name: JSON.parse(database.name.slice(prefix.length))[1], version: database.version, stores};
  }

  async command(id, origin, cmd) {
    await this.ready;
    const client = this.client(id, origin);
    const emit_error = error => this.emit(client, {target: cmd.request || cmd.transaction, type: "error", error: error_data(error)});
    try {
      switch (cmd.op) {
        case "open": {
          const name = database_name(origin, cmd.name);
          const request = cmd.version === undefined ? this.factory.open(name) : this.factory.open(name, cmd.version);
          request.onupgradeneeded = event => {
            if (!client.active) { request.transaction.abort(); return; }
            const database = request.result;
            client.objects.set(cmd.database, database);
            if (!database.objectStoreNames.contains(keeper)) database.createObjectStore(keeper);
            this.hold(client, request.transaction, cmd.transaction);
            const stores = [...database.objectStoreNames].filter(name => name !== keeper).map(name => describe_store(request.transaction.objectStore(name)));
            this.emit(client, {target: cmd.request, type: "upgradeneeded", oldVersion: event.oldVersion, newVersion: event.newVersion,
              resultKind: "database", value: {id: cmd.database, name: cmd.name, version: database.version, stores}, transaction: cmd.transaction});
          };
          request.onblocked = event => this.emit(client, {target: cmd.request, type: "blocked", oldVersion: event.oldVersion, newVersion: event.newVersion});
          request.onerror = () => emit_error(request.error);
          request.onsuccess = () => {
            const database = request.result;
            if (!client.active) { database.close(); return; }
            client.objects.set(cmd.database, database);
            database.onversionchange = event => this.emit(client, {target: cmd.database, type: "versionchange", oldVersion: event.oldVersion, newVersion: event.newVersion});
            database.onclose = () => this.emit(client, {target: cmd.database, type: "close"});
            this.emit(client, {target: cmd.request, type: "success", resultKind: "database", value: this.describe(database, cmd.database)});
            this.known = this.known.filter(item => item.origin !== origin || item.name !== cmd.name);
            this.known.push({origin, name: cmd.name, version: database.version});
            this.catalog().catch(() => {});
          };
          break;
        }
        case "delete": {
          const request = this.factory.deleteDatabase(database_name(origin, cmd.name));
          request.onblocked = event => this.emit(client, {target: cmd.request, type: "blocked", oldVersion: event.oldVersion, newVersion: null});
          request.onerror = () => emit_error(request.error);
          request.onsuccess = event => {
            this.known = this.known.filter(item => item.origin !== origin || item.name !== cmd.name);
            this.emit(client, {target: cmd.request, type: "success", value: undefined, oldVersion: event.oldVersion, newVersion: null});
            this.catalog().catch(() => {});
          };
          break;
        }
        case "close": client.objects.get(cmd.database)?.close(); client.objects.delete(cmd.database); break;
        case "transaction": {
          const database = client.objects.get(cmd.database);
          const names = [...new Set([...cmd.stores.map(physical_store), keeper])];
          const transaction = database.transaction(names, cmd.mode, cmd.options);
          this.hold(client, transaction, cmd.transaction);
          break;
        }
        case "release": {
          const record = client.transactions.get(cmd.transaction);
          if (record) record.holding = false;
          break;
        }
        case "abort": client.transactions.get(cmd.transaction)?.tx.abort(); break;
        case "schema":
          await this.enqueue(client, cmd.transaction, tx => {
            const database = tx.db;
            if (cmd.method === "createObjectStore") database.createObjectStore(physical_store(cmd.store), cmd.options);
            else if (cmd.method === "deleteObjectStore") database.deleteObjectStore(physical_store(cmd.store));
            else if (cmd.method === "renameStore") tx.objectStore(physical_store(cmd.store)).name = physical_store(cmd.name);
            else if (cmd.method === "createIndex") tx.objectStore(physical_store(cmd.store)).createIndex(cmd.name, cmd.keyPath, cmd.options);
            else if (cmd.method === "deleteIndex") tx.objectStore(physical_store(cmd.store)).deleteIndex(cmd.name);
            else if (cmd.method === "renameIndex") tx.objectStore(physical_store(cmd.store)).index(cmd.index).name = cmd.name;
            else throw new TypeError("Unknown schema operation");
          });
          break;
        case "request":
          await this.enqueue(client, cmd.transaction, tx => {
            let target = tx.objectStore(physical_store(cmd.store));
            if (cmd.index !== undefined) target = target.index(cmd.index);
            if (cmd.cursor) target = client.objects.get(cmd.cursor);
            const methods = new Set(["get", "getKey", "getAll", "getAllKeys", "getAllRecords", "count", "put", "add", "delete", "clear", "openCursor", "openKeyCursor", "update"]);
            if (!methods.has(cmd.method)) throw new TypeError("Unknown request operation");
            const args = cmd.args.map(value => decode_key(value, this.Range));
            const request = target[cmd.method](...args);
            this.request(client, request, cmd, cmd.method === "openCursor" || cmd.method === "openKeyCursor");
          });
          break;
        case "cursor":
          await this.enqueue(client, cmd.transaction, () => {
            if (!["advance", "continue", "continuePrimaryKey"].includes(cmd.method)) throw new TypeError("Unknown cursor operation");
            client.objects.get(cmd.cursor)[cmd.method](...cmd.args);
          });
          break;
        default: throw new TypeError("Unknown database operation");
      }
    } catch (error) {
      emit_error(error);
    }
  }

  async catalog() {
    await this.ready;
    let databases;
    try { databases = await this.factory.databases(); }
    catch { this.onCatalog(this.known); return this.known; }
    const result = [];
    for (const database of databases) {
      if (!database.name?.startsWith(prefix) || database.name === prefix + "probe") continue;
      try {
        const [origin, name] = JSON.parse(database.name.slice(prefix.length));
        result.push({origin, name, version: database.version});
      } catch {}
    }
    this.onCatalog(result);
    this.known = result;
    return result;
  }

  async databases(origin) { return (await this.catalog()).filter(item => item.origin === origin).map(({name, version}) => ({name, version})); }

  async clear(hostname) {
    const databases = (await this.catalog()).filter(item => new URL(item.origin).hostname === hostname);
    for (const client of [...this.clients.values()]) {
      if (new URL(client.origin).hostname === hostname) this.disconnect(client.id);
    }
    await Promise.all(databases.map(item => new Promise((resolve, reject) => {
      const request = this.factory.deleteDatabase(database_name(item.origin, item.name));
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    })));
    this.known = this.known.filter(item => new URL(item.origin).hostname !== hostname);
    await this.catalog();
  }
}
