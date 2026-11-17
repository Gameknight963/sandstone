import { IndexedDBService } from "../idb/service.mjs";
import { iframes } from "./controller.mjs";
import { rpc_handlers } from "../rpc.mjs";
import { site_data } from "./site_data.mjs";
import {crypto_service} from './crypto.mjs';

let factory;
let Range;
try {
  if (typeof window !== "undefined") {
    factory = window.indexedDB;
    Range = window.IDBKeyRange;
  }
} catch {}
export const indexed_db = new IndexedDBService(factory, {
  Range,
  known: site_data.indexed,
  onCatalog(catalog) { site_data.indexed = catalog; site_data.persist(); }
});

function origin(id) {
  const value = iframes[id]?.origin || iframes[id]?.url?.origin;
  if (!value || value === "null") throw new DOMException("Database origin is unavailable", "SecurityError");
  return value;
}

rpc_handlers["idb_command"] = (id, command) => indexed_db.command(id, origin(id), crypto_service.decode(command));
rpc_handlers["idb_poll"] = async id => crypto_service.encode(await indexed_db.poll(id, origin(id)));
rpc_handlers["idb_databases"] = id => indexed_db.databases(origin(id));
