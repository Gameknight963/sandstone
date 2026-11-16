import * as loader from "../loader.mjs";
import * as rpc from "../../rpc.mjs";
import { IDBFactory } from "../../idb/client.mjs";

export * from "../../idb/client.mjs";
const command = rpc.create_rpc_wrapper(rpc.host, "idb_command");
const poll = rpc.create_rpc_wrapper(rpc.host, "idb_poll");
const databases = rpc.create_rpc_wrapper(rpc.host, "idb_databases");
export const indexedDB = new IDBFactory({
  command: value => command(loader.frame_id, value),
  poll: () => poll(loader.frame_id),
  databases: () => databases(loader.frame_id)
});
