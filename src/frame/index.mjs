export * as loader from "./loader.mjs";
export * as network from "./network.mjs";
export * as context from "./context.mjs";
export * as parser from "./parser.mjs";
export * as html_stream from './html_dom_stream.mjs';
export * as script_schedule from './script_schedule.mjs';
export * as worker from "./polyfill/worker.mjs";
export * as storage_sync from './storage_sync.mjs';
export {seed_encoder} from '../bootstrap.mjs';

export * as rpc from "../rpc.mjs";

import * as rpc from "../rpc.mjs";
import './service_worker_host.mjs';
rpc.set_role("frame");
