import * as network from "../network.mjs";
import { ctx } from "../context.mjs";
import { create_xhr_class } from "../xhr.mjs";
import {sync_worker_request,sync_worker_available} from './worker.mjs';

export const FakeXMLHttpRequest = create_xhr_class({
  fetch: network.fetch,
  base: () => ctx.document?.baseURI || ctx.location.href,
  client_referrer: () => ctx.document&&/^about:blank(?:#|$)/.test(ctx.location.href)?'':undefined,
  isWorker: typeof importScripts === "function",
  sync_fetch:sync_worker_request,sync_available:sync_worker_available
});
