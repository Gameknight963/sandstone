import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory as MemoryFactory } from "fake-indexeddb";
import { IndexedDBService } from "../src/idb/service.mjs";
import { IDBFactory, IDBKeyRange } from "../src/idb/client.mjs";
import Dexie from "dexie";

const result = request => new Promise((resolve, reject) => {
  request.addEventListener("success", () => resolve(request.result), {once: true});
  request.addEventListener("error", () => reject(request.error), {once: true});
});
const complete = transaction => new Promise((resolve, reject) => {
  transaction.addEventListener("complete", resolve, {once: true});
  transaction.addEventListener("abort", () => reject(transaction.error || new DOMException("Transaction aborted", "AbortError")), {once: true});
});

function environment() {
  const service = new IndexedDBService(new MemoryFactory());
  let sequence = 0;
  const factory = (origin = "https://example.com") => {
    const id = "client:" + ++sequence;
    return new IDBFactory({
      command: command => service.command(id, origin, structuredClone(command)),
      poll: async () => structuredClone(await service.poll(id, origin)),
      databases: () => service.databases(origin)
    });
  };
  const close = () => { for (const id of service.clients.keys()) service.disconnect(id); };
  return {service, factory, close};
}

async function open(factory, name = "database", upgrade) {
  const request = factory.open(name, 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    const store = database.createObjectStore("records", {keyPath: "id", autoIncrement: true});
    store.createIndex("byName", "name", {unique: true});
    upgrade?.(store, request.transaction);
  };
  return result(request);
}

test("IndexedDB broker supports upgrades, generated keys, indexes and binary values", {timeout: 5000}, async () => {
  const env = environment();
  try {
    const factory = env.factory();
    const database = await open(factory);
    assert.deepEqual([...database.objectStoreNames], ["records"]);
    const tx = database.transaction("records", "readwrite");
    const done = complete(tx);
    const store = tx.objectStore("records");
    const key = await result(store.add({name: "first", bytes: new Uint8Array([1, 2, 3]), date: new Date(0), cursor: true, database: true}));
    assert.equal(key, 1);
    const value = await result(store.index("byName").get("first"));
    assert.equal(value.id, 1);
    assert.equal(value.cursor, true);
    assert.equal(value.database, true);
    assert.deepEqual([...value.bytes], [1, 2, 3]);
    assert.equal(value.date.getTime(), 0);
    await done;
    database.close();
    assert.deepEqual(await factory.databases(), [{name: "database", version: 1}]);
  } finally { env.close(); }
});

test("Aborted writes roll back and prevented constraint errors keep transactions alive", {timeout: 5000}, async () => {
  const env = environment();
  try {
    const database = await open(env.factory());
    let tx = database.transaction("records", "readwrite");
    let done = complete(tx);
    const aborted = assert.rejects(done, {name: "AbortError"});
    await result(tx.objectStore("records").add({name: "rolled back"}));
    tx.abort();
    await aborted;
    assert.equal(tx.error, null);
    tx = database.transaction("records", "readwrite");
    done = complete(tx);
    const store = tx.objectStore("records");
    await result(store.add({name: "unique"}));
    const duplicate = store.add({name: "unique"});
    duplicate.onerror = event => event.preventDefault();
    await assert.rejects(result(duplicate), {name: "ConstraintError"});
    await result(store.add({name: "second"}));
    assert.equal(await result(store.count()), 2);
    await done;
    database.close();
  } finally { env.close(); }
});

test("Cursors preserve request identity, support ranges and allow updates", {timeout: 5000}, async () => {
  const env = environment();
  try {
    const database = await open(env.factory(), "cursor", store => {
      store.add({id: 1, name: "a"}); store.add({id: 2, name: "b"}); store.add({id: 3, name: "c"});
    });
    const tx = database.transaction("records", "readwrite");
    const done = complete(tx);
    const values = [];
    const request = tx.objectStore("records").openCursor(IDBKeyRange.bound(1, 2));
    let firstCursor;
    await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(); return; }
        if (!firstCursor) firstCursor = cursor;
        else assert.equal(cursor, firstCursor);
        values.push(cursor.primaryKey);
        if (cursor.key === 1) cursor.update({id: 1, name: "updated"});
        cursor.continue();
      };
    });
    assert.deepEqual(values, [1, 2]);
    const changed = await result(tx.objectStore("records").get(1));
    assert.equal(changed.name, "updated");
    await done;
    database.close();
  } finally { env.close(); }
});

test("Origins are isolated while clients of the same origin share committed data", {timeout: 5000}, async () => {
  const env = environment();
  try {
    const first = await open(env.factory(), "shared", store => store.add({name: "shared"}));
    const second = await open(env.factory(), "shared");
    const isolated = await open(env.factory("https://other.test"), "shared");
    assert.equal(await result(second.transaction("records").objectStore("records").count()), 1);
    assert.equal(await result(isolated.transaction("records").objectStore("records").count()), 0);
    first.close(); second.close(); isolated.close();
    await env.service.clear("example.com");
    assert.deepEqual((await env.service.catalog()).map(item => item.origin), ["https://other.test"]);
  } finally { env.close(); }
});

test("Transaction inactivity and synchronous API validation match browser expectations", {timeout: 5000}, async () => {
  const env = environment();
  try {
    const factory = env.factory();
    assert.throws(() => factory.open("invalid", 0), TypeError);
    const database = await open(factory);
    assert.throws(() => database.transaction("missing"), {name: "NotFoundError"});
    const tx = database.transaction("records");
    const done = complete(tx);
    assert.throws(() => tx.objectStore("records").put({name: "no"}), {name: "ReadOnlyError"});
    assert.throws(() => tx.objectStore("records").get({invalid: "key"}), {name: "DataError"});
    await done;
    assert.throws(() => tx.objectStore("records"), {name: "InvalidStateError"});
    database.close();
  } finally { env.close(); }
});

test("Concurrent read-modify-write transactions across clients do not lose updates", {timeout: 5000}, async () => {
  const env = environment();
  try {
    const first = await open(env.factory(), "counter", store => store.add({id: 1, name: "counter", count: 0}));
    const second = await open(env.factory(), "counter");
    async function increment(database) {
      const tx = database.transaction("records", "readwrite");
      const committed = complete(tx);
      const store = tx.objectStore("records");
      const value = await result(store.get(1));
      value.count++;
      await result(store.put(value));
      await committed;
    }
    await Promise.all(Array.from({length: 20}, (_, index) => increment(index % 2 ? first : second)));
    assert.equal((await result(first.transaction("records").objectStore("records").get(1))).count, 20);
    first.close(); second.close();
  } finally { env.close(); }
});

test("Dexie can upgrade, bulk-write, query indexes and roll back transactions", {timeout: 5000}, async () => {
  const env = environment();
  const database = new Dexie("dexie-fixture", {indexedDB: env.factory(), IDBKeyRange});
  try {
    database.version(1).stores({items: "++id,&name"});
    await database.open();
    await database.items.bulkAdd([{name: "alpha"}, {name: "beta"}]);
    assert.deepEqual((await database.items.orderBy("name").toArray()).map(item => item.name), ["alpha", "beta"]);
    await assert.rejects(database.transaction("rw", database.items, async () => {
      await database.items.add({name: "rolled-back"});
      throw new Error("rollback");
    }), /rollback/);
    assert.equal(await database.items.count(), 2);
    await database.items.where("name").equals("alpha").modify({name: "changed"});
    assert.equal((await database.items.get(1)).name, "changed");
  } finally { database.close(); env.close(); }
});
